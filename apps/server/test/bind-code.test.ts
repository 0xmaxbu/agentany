// T5（#60）：自助绑定（#bind 一次性码 / #unbind）+ admin 只读+兜底解绑。
// seam：
//   - store 层：issueBindCode/consumeBindCode 生命周期（单次 CAS / TTL / 高熵）单测
//   - 命令解析：parseImCommand 纯函数
//   - e2e：makeFeishuInbound 直调（Web 发码 → #bind → 补发卡+回执；#unbind；未绑定普通文本静默）——不需 WS 层
import { describe, test, expect, beforeEach } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { RunRegistry } from "../src/runs/registry";
import { ImStore, BIND_CODE_TTL_MS } from "../src/im/store";
import { FeishuTransport } from "../src/im/feishu/transport";
import { makeFeishuInbound } from "../src/im/feishu/inbound";
import { parseImCommand } from "../src/im/commands";
import { fakeFeishu, fakeFeishuFetch, receiveTextEvent } from "./fake-feishu";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi, ConfiguredRunPiStream } from "../src/pi/runPi-factory";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const stubRunPiFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });

function setup() {
  const db = openDbMigrated(":memory:");
  const store = new WorkflowStore(db);
  const userStore = new UserStore(db);
  const eventBus = new EventBus();
  const queues = new ConversationQueues();
  const deps: RunDeps = {
    store, userStore,
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store),
    eventBus, conversationQueues: queues, imStore: new ImStore(db),
    runRegistry: new RunRegistry({ store, eventBus, runPiFactory: stubRunPiFactory }),
    runPiStreamFactory: (): ConfiguredRunPiStream => async (call) => ({ text: "", messages: [], toolResults: [] }),
  };
  const fake = fakeFeishu();
  const transport = new FeishuTransport({ appId: "cli_x", appSecret: "s", baseUrl: "https://fake.feishu", fetchFn: fakeFeishuFetch(fake.app) });
  const inbound = makeFeishuInbound(deps, transport);
  return { db, store, userStore, deps, fake, transport, inbound };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => { ctx = setup(); });

const newUser = async (u: string) => { await ctx.userStore.createUser({ username: u, password: "pw-long-enough", role: u === "ad" ? "admin" : "member" }); return ctx.userStore.getUserByUsername(u)!; };

describe("绑定码存储（issue/consume 生命周期）", () => {
  const mkUser = async (u: string) => { await ctx.userStore.createUser({ username: u, password: "pw-long-enough", role: "member" }); return ctx.userStore.getUserByUsername(u)!; };

  test("issue：高熵 + 10min TTL", async () => {
    const u = await mkUser("u");
    const { code, expiresAt } = ctx.deps.imStore!.issueBindCode(u.id);
    expect(code.length).toBeGreaterThanOrEqual(32); // 128-bit hex
    const ttl = new Date(expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(BIND_CODE_TTL_MS - 2000);
    expect(ttl).toBeLessThanOrEqual(BIND_CODE_TTL_MS);
  });

  test("consume：单次 CAS——首删成功、重放拒（同码二次消费为 null）", async () => {
    const u = await mkUser("u");
    const { code } = ctx.deps.imStore!.issueBindCode(u.id);
    expect(ctx.deps.imStore!.consumeBindCode(code)!.userId).toBe(u.id);
    expect(ctx.deps.imStore!.consumeBindCode(code)).toBeNull(); // 重放拒（usedAt CAS）
  });

  test("过期码拒绝；不存在拒绝", async () => {
    expect(ctx.deps.imStore!.consumeBindCode("nope-not-exist")).toBeNull();
    const u = await mkUser("u");
    const expired = ctx.deps.imStore!.issueBindCode(u.id, -1000); // 已过期
    expect(ctx.deps.imStore!.consumeBindCode(expired.code)).toBeNull();
  });

  test("listPendingCardsForUser：跨会话全量 pending（含 approval/task，按 id 序）", async () => {
    const u = await mkUser("u");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: u.id });
    ctx.store.createConversation({ id: "c2", workspaceId: "ws_company", userId: u.id });
    const q1 = ctx.store.createQuestion({ conversationId: "c1", runId: null, prompt: "澄清", options: ["A"] });
    const q2 = ctx.store.createQuestion({ conversationId: "c2", kind: "approval", workflowId: "w", input: {}, prompt: "审批", options: ["批准", "拒绝"] });
    ctx.store.createQuestion({ conversationId: "c1", runId: null, prompt: "已答", options: ["A"] });
    ctx.store.markQuestionAnswered(ctx.store.listQuestions("c1").find((q) => q.prompt === "已答")!.id, "A");
    ctx.store.archiveConversation("c2"); // 归档会话的 pending 不计
    const rows = ctx.store.listPendingCardsForUser(u.id);
    expect(rows.map((r) => r.id)).toEqual([q1]); // c2 归档排除 + 已答排除
    expect(rows.some((r) => r.id === q2)).toBe(false);
  });
});

describe("parseImCommand（#bind/#unbind 语法）", () => {
  test("#bind <code> → {kind:bind,code}；空白容忍", () => {
    expect(parseImCommand("#bind abc123")).toEqual({ kind: "bind", code: "abc123" });
    expect(parseImCommand("  #bind   xyz  ")).toEqual({ kind: "bind", code: "xyz" });
  });
  test("非命令 / 无码 #bind / 超长码 → null", () => {
    expect(parseImCommand("hello")).toBeNull();
    expect(parseImCommand("#bind")).toBeNull();
    expect(parseImCommand("#bind ")).toBeNull();
    expect(parseImCommand("#bind " + "a".repeat(65))).toBeNull();
  });
  test("#unbind 精确匹配", () => {
    expect(parseImCommand("#unbind")).toEqual({ kind: "unbind" });
    expect(parseImCommand("  #unbind  ")).toEqual({ kind: "unbind" });
    expect(parseImCommand("#unbind x")).toBeNull();
  });
});

describe("e2e：#bind → 补发 + 回执；#unbind；未绑定普通文本静默", () => {
  const pub = (text: string, openId = "ou_1") => ctx.inbound(receiveTextEvent(openId, text));

  test("Web 发码 → #bind 成功 → 回执含待办数 + 补发卡各一次（interactive + 按钮 value）", async () => {
    const m1 = await newUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.store.createConversation({ id: "c2", workspaceId: "ws_company", userId: m1.id });
    const qid1 = ctx.store.createQuestion({ conversationId: "c1", runId: null, prompt: "预算？", options: ["<10w"] });
    ctx.store.createQuestion({ conversationId: "c2", kind: "approval", workflowId: "w", input: {}, prompt: "审批", options: ["批准", "拒绝"] });
    const { code } = ctx.deps.imStore!.issueBindCode(m1.id);

    await pub(`#bind ${code}`);
    await new Promise((r) => setTimeout(r, 20)); // 补发 send 异步落 stub

    expect(ctx.deps.imStore!.resolve("ou_1", "feishu")!.userId).toBe(m1.id);
    const sends = ctx.fake.state.sent;
    expect(sends).toHaveLength(3); // 回执文本 + 2 张补发卡
    const replies = sends.filter((s) => s.msgType === "text");
    expect(replies).toHaveLength(1);
    expect(String((replies[0].content as any).text)).toContain("绑定成功");
    expect(String((replies[0].content as any).text)).toContain("2 张待处理卡片");
    const cards = sends.filter((s) => s.msgType === "interactive");
    expect(cards).toHaveLength(2);
    expect(cards.some((s) => s.uuid === `${qid1}:hitl_request`)).toBe(true);
    expect((cards[0].content as any).body.elements[1].actions[0].behaviors[0].value.questionId).toBe(qid1);
  });

  test("绑定码单次性：用过-解绑-重放 → 拒；乱码/过期 → 拒，均不绑定不补发", async () => {
    const m1 = await newUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.store.createQuestion({ conversationId: "c1", runId: null, prompt: "p", options: ["A"] });
    const { code } = ctx.deps.imStore!.issueBindCode(m1.id);
    await pub(`#bind ${code}`); // 首次成功
    expect(ctx.deps.imStore!.resolve("ou_1", "feishu")!.userId).toBe(m1.id);
    ctx.fake.state.sent.length = 0;
    await pub("#unbind"); // 解绑 → 现在重放码是纯「已用」态
    ctx.fake.state.sent.length = 0;

    // 已用码重放（解绑后）→ 无效或已过期
    await pub(`#bind ${code}`);
    await delay(10);
    expect(String((ctx.fake.state.sent.at(-1)!.content as any).text)).toContain("无效或已过期");
    expect(ctx.fake.state.sent).toHaveLength(1); // 只有错误回执，无补发
    // 乱码 → 拒绝
    await pub("#bind deadbeef");
    await delay(10);
    expect(String((ctx.fake.state.sent.at(-1)!.content as any).text)).toContain("无效或已过期");
    // 过期码 → 拒绝
    const expired = ctx.deps.imStore!.issueBindCode(m1.id, -1000);
    await pub(`#bind ${expired.code}`);
    await delay(10);
    expect(String((ctx.fake.state.sent.at(-1)!.content as any).text)).toContain("无效或已过期");
    expect(ctx.deps.imStore!.resolve("ou_1", "feishu")).toBeUndefined(); // 从未重新绑定
    expect(ctx.fake.state.sent.filter((s) => s.msgType === "interactive")).toHaveLength(0); // 无补发
  });

  test("已绑定重复 #bind → 提示；#unbind → 解绑 + 回执；解绑后再补发不再发", async () => {
    const m1 = await newUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.deps.imStore!.bind("ou_1", "feishu", m1.id);
    const qid1 = ctx.store.createQuestion({ conversationId: "c1", runId: null, prompt: "p", options: ["A"] });

    const code1 = ctx.deps.imStore!.issueBindCode(m1.id).code;
    await pub(`#bind ${code1}`); // 已绑定 → 提示不补发
    await delay(10);
    const afterDup = ctx.fake.state.sent.map((s) => String((s.content as any).text ?? "")).join("|");
    expect(afterDup).toContain("您已绑定");

    await pub("#unbind");
    await delay(10);
    expect(ctx.deps.imStore!.resolve("ou_1", "feishu")).toBeUndefined();
    expect(String((ctx.fake.state.sent.at(-1)!.content as any).text)).toContain("已解绑");
    // 解绑后再 #bind 新码 → 补发 c1 的 pending
    const code2 = ctx.deps.imStore!.issueBindCode(m1.id).code;
    await pub(`#bind ${code2}`);
    await delay(10);
    expect(ctx.deps.imStore!.resolve("ou_1", "feishu")!.userId).toBe(m1.id);
    const cards = ctx.fake.state.sent.filter((s) => s.msgType === "interactive");
    expect(cards.length).toBeGreaterThanOrEqual(1); // c1 卡补发
    expect(cards.some((s) => s.uuid === `${qid1}:hitl_request`)).toBe(true);
  });

  test("未绑定普通文本 → 静默丢弃（不回执不补发，永不影响会话）", async () => {
    const m1 = await newUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.store.createQuestion({ conversationId: "c1", runId: null, prompt: "p", options: ["A"] });
    await pub("你好可以吗", "ou_unknown"); // 未绑定的 open_id 发普通文本
    await delay(10);
    expect(ctx.fake.state.sent).toHaveLength(0); // 静默
    expect(ctx.store.listMessages("c1")).toHaveLength(0); // 未落库
  });

  test("#bind 码消费后，绑定关系即刻用于回流（补发后打字 → 判答）", async () => {
    const m1 = await newUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    const qid1 = ctx.store.createQuestion({ conversationId: "c1", runId: null, prompt: "澄清", options: ["A"] });
    const { code } = ctx.deps.imStore!.issueBindCode(m1.id);
    await pub(`#bind ${code}`);
    await delay(10);
    // 绑定后普通文本 → handleImInbound 判答（此处 deps 无 runPiStreamFactory → 走默认，但用不上判定 stub——
    // 只验证「不再静默丢弃」：至少会落库一条 user 消息（queue 起轮）
    await pub("A");
    await delay(10);
    expect(ctx.store.listMessages("c1").some((m) => m.role === "user" && m.content === "A")).toBe(true);
    void qid1;
  });
});