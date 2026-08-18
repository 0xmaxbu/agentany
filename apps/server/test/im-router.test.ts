// T1+T3（#56/#58）：出站路由胶水——EventBus 帧 → 会话 owner 绑定 → 平台 send（假飞书断言收到）。
// T3 后 hitl_request → 交互卡（interactive，按钮 value={questionId,label} 结构断言）；hitl_answered → 确认回执文本。
// seam：真 store + 真 EventBus + ImOutboundRouter + stub 平台（fake-feishu）；断言目标/形态/uuid。
import { describe, test, expect, beforeEach } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { EventBus } from "../src/chat/eventbus";
import { ImStore } from "../src/im/store";
import { ImOutboundRouter } from "../src/im/outbound-router";
import { FeishuTransport } from "../src/im/feishu/transport";
import { fakeFeishu, fakeFeishuFetch } from "./fake-feishu";

function setup() {
  const db = openDbMigrated(":memory:");
  const store = new WorkflowStore(db);
  const userStore = new UserStore(db);
  const bus = new EventBus();
  const imStore = new ImStore(db);
  const fake = fakeFeishu();
  const platform = new FeishuTransport({ appId: "cli_x", appSecret: "s_y", baseUrl: "https://fake.feishu", fetchFn: fakeFeishuFetch(fake.app) });
  const router = new ImOutboundRouter({ store, imStore, bus, platform });
  return { store, userStore, imStore, bus, fake, router };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => { ctx = setup(); });

const makeUser = async (u: string) => { await ctx.userStore.createUser({ username: u, password: "pw-long-enough", role: "member" }); return ctx.userStore.getUserByUsername(u)!; };

/** 建一张 ask 卡 row 并返回 qid（路由器用 question 行打素材——按钮 value/开放度）。 */
const makeAsk = (convId: string, prompt: string, options: string[], extra: { values?: { label: string; value: unknown }[]; resumeSchema?: unknown } = {}) =>
  ctx.store.createQuestion({ conversationId: convId, runId: null, prompt, options, values: extra.values, resumeSchema: extra.resumeSchema });

describe("ImOutboundRouter（出站路由胶水）", () => {
  test("hitl_request → owner 收交互卡（interactive），按钮 callback value={questionId,label}，uuid=questionId:type", async () => {
    const m1 = await makeUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.imStore.bind("ou_m1", "feishu", m1.id);
    const qid = makeAsk("c1", "选哪个方案？", ["A", "B"], { values: [{ label: "A", value: { plan: "A" } }, { label: "B", value: { plan: "B" } }] });
    ctx.router.subscribeAll();
    ctx.bus.publish("c1", { type: "hitl_request", questionId: qid, runId: null, prompt: "选哪个方案？", options: ["A", "B"], kind: "ask" });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(1);
    expect(ctx.fake.state.sent[0].receiveId).toBe("ou_m1");
    expect(ctx.fake.state.sent[0].msgType).toBe("interactive"); // 卡片优先于纯文本
    expect(ctx.fake.state.sent[0].uuid).toBe(`${qid}:hitl_request`);
    const card = ctx.fake.state.sent[0].content as any;
    expect(card.schema).toBe("2.0");
    expect(card.body.elements[0].text.content).toContain("选哪个方案？");
    const buttons = card.body.elements.filter((e: any) => e.tag === "button");
    expect(buttons).toHaveLength(2);
    expect(card.body.elements.some((e: any) => e.tag === "action")).toBe(false); // 2.0 无 action 容器（live smoke 修复）
    expect(buttons[0].behaviors[0].value).toEqual({ questionId: qid, value: "A" });
  });

  test("开放 schema → 卡带 footer；hitl_answered → 确认回执文本（同路由）；非 hitl 帧不产出", async () => {
    const m1 = await makeUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.imStore.bind("ou_m1", "feishu", m1.id);
    const qid = makeAsk("c1", "预算？", ["<10w"], { resumeSchema: { _t: "object", shape: { budget: { _t: "string" } } } });
    ctx.router.subscribeAll();
    ctx.bus.publish("c1", { type: "hitl_request", questionId: qid, runId: null, prompt: "预算？", options: ["<10w"], kind: "ask" });
    await new Promise((r) => setTimeout(r, 10));
    expect((ctx.fake.state.sent[0].content as any).body.elements.some((e: any) => e.tag === "div" && e.text?.content)).toBe(true); // 开放 → footer 显（note 已废弃 → div 同形）

    ctx.bus.publish("c1", { type: "hitl_answered", questionId: qid, answer: { decision: "accept" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(2); // answered → 文本回执
    const receipt = ctx.fake.state.sent[1];
    expect(receipt.msgType).toBe("text"); // 回执 = 纯文本确认（非卡）
    expect((receipt.content as { text: string }).text).toContain("已处理");
    expect(receipt.uuid).toBe(`${qid}:hitl_answered`);

    ctx.bus.publish("c1", { type: "user_message", id: 1, content: "hi" });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(2); // 非 hitl 帧不路由
  });

  test("owner 未绑 feishu（或只绑其它平台）→ 不发送", async () => {
    const m2 = await makeUser("m2");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m2.id }); // 未绑定
    ctx.store.createConversation({ id: "c2", workspaceId: "ws_company", userId: m2.id });
    ctx.imStore.bind("dt_m2", "dingtalk", m2.id); // 只绑钉钉
    ctx.router.subscribeAll();
    txt(ctx, "c1", 1, "p", []); txt(ctx, "c2", 2, "q", []);
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(0);
  });

  test("归档会话不入订阅；subscribeAll 幂等（重复调用不重复投递）", async () => {
    const m1 = await makeUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.store.createConversation({ id: "c2", workspaceId: "ws_company", userId: m1.id });
    ctx.imStore.bind("ou_m1", "feishu", m1.id);
    ctx.store.archiveConversation("c2"); // 归档 → 不订阅
    ctx.router.subscribeAll();
    ctx.router.subscribeAll(); // 幂等
    const qid = makeAsk("c1", "p", ["A"]); makeAsk("c2", "q", ["B"]);
    ctx.bus.publish("c1", { type: "hitl_request", questionId: qid, runId: null, prompt: "p", options: ["A"], kind: "ask" });
    ctx.bus.publish("c2", { type: "hitl_request", questionId: qid + 1, runId: null, prompt: "q", options: ["B"], kind: "ask" });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(1); // c2 归档不送；c1 只送一次
    expect(ctx.fake.state.sent[0].uuid).toBe(`${qid}:hitl_request`);
  });

  test("question 行不可用（帧的 questionId 无行）→ 不追发（静默）；close() 后退订", async () => {
    const m1 = await makeUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.imStore.bind("ou_m1", "feishu", m1.id);
    ctx.router.subscribeAll();
    ctx.bus.publish("c1", { type: "hitl_request", questionId: 999, runId: null, prompt: "p", options: [], kind: "ask" }); // 无害行
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(0); // 无行不追发
    ctx.router.close();
    const qid = makeAsk("c1", "p", ["A"]);
    ctx.bus.publish("c1", { type: "hitl_request", questionId: qid, runId: null, prompt: "p", options: ["A"], kind: "ask" });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(0); // 退订
  });
});

/** 直发 hitl_request 帧（不建行——纯帧通路，仅测无行不发送/送文本回落场景）。 */
function txt(c: ReturnType<typeof setup>, convId: string, questionId: number, prompt: string, options: string[]) {
  c.bus.publish(convId, { type: "hitl_request", questionId, runId: null, prompt, options, kind: "ask" });
}