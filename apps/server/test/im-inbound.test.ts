// T2（#51）：IM 入站回流——身份绑定 resolve + pending 查询 + 复用内联 turn（纯逻辑 handleImInbound）。
// seam：平台无关纯函数 handleImInbound（类 hitl-dispatch 的 handler 模式）+ 直查 store 断言副作用 + 真 EventBus 捕帧。
import { describe, test, expect, beforeEach } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { RunRegistry } from "../src/runs/registry";
import { ImStore } from "../src/im/store";
import { handleImInbound } from "../src/im/inbound";
import { dispatchCardAnswer } from "../src/chat/hitl-dispatch";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi, ConfiguredRunPiStream } from "../src/pi/runPi-factory";

const JH = { "content-type": "application/json" };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(10); }
};
const runIdFrom = (s: string): string | null => s.match(/r_[A-Za-z0-9-]+/)?.[0] ?? null;

const stubRunPiFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });

/** 判定 stub：读到 [待处理提问] 注入后程序化判答（等价 pi 经 bridge resume_workflow / answer_question 的 clean 分支）。
 *  run 绑定 → registry.resume + markPendingAnsweredByRun + hitl_answered；自主卡 → markQuestionAnswered + hitl_answered。 */
const makeJudgeStream = (deps: RunDeps, log: { calls: number; appends: string[][] }): ConfiguredRunPiStream => async (call) => {
  log.calls++;
  const appends = (call as any).appendSystemPrompt ?? [];
  log.appends.push(appends);
  const runEl = appends.find((s: string) => s.startsWith("[待处理提问] 工作流"));
  if (runEl && deps.runRegistry) {
    const runId = runIdFrom(runEl);
    if (runId) {
      const outcome = await deps.runRegistry.resume(runId, { decision: "accept" });
      if (!("rejected" in outcome) && !("idempotent" in outcome)) {
        const row = deps.store.markPendingAnsweredByRun(runId, { decision: "accept" });
        const convOf = deps.store.getRun(runId)?.conversationId;
        if (row && convOf) deps.eventBus!.publish(convOf, { type: "hitl_answered", questionId: row.id, answer: { decision: "accept" }, kind: "ask", runId });
      }
    }
  }
  const askEl = appends.find((s: string) => s.startsWith("[待处理提问] 澄清"));
  if (askEl) {
    const qid = askEl.match(/answer_question\((\d+)/)?.[1];
    if (qid) {
      const row = deps.store.markQuestionAnswered(Number(qid), { plan: "按 IM 文本归一化" });
      if (row) deps.eventBus!.publish(row.conversationId, { type: "hitl_answered", questionId: row.id, answer: { plan: "按 IM 文本归一化" }, kind: "ask" });
    }
  }
  call.onBlock?.({ op: "start", blockId: "b1", kind: "text" });
  call.onBlock?.({ op: "delta", blockId: "b1", delta: "回答已记录。" });
  call.onBlock?.({ op: "end", blockId: "b1" });
  return { text: "回答已记录。", messages: [], toolResults: [] };
};

async function setup(streamCtor: (deps: RunDeps, log: { calls: number; appends: string[][] }) => ConfiguredRunPiStream = makeJudgeStream) {
  const db = openDbMigrated(":memory:");
  const store = new WorkflowStore(db);
  const userStore = new UserStore(db);
  const eventBus = new EventBus();
  const queues = new ConversationQueues();
  const log = { calls: 0, appends: [] as string[][] };
  // runPiStreamFactory 签名 = (opts) => ConfiguredRunPiStream；deps 惰性自引用（箭头调用时才解引用，此时 deps 已定位）。
  const deps: RunDeps = {
    store, userStore,
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store),
    eventBus, conversationQueues: queues,
    imStore: new ImStore(db),
    runRegistry: new RunRegistry({ store, eventBus, runPiFactory: stubRunPiFactory }),
    runPiStreamFactory: () => streamCtor(deps, log),
  };
  const app = createApp(deps);
  const login = async (u: string) => {
    const r = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: u, password: "pw-long-enough" }) });
    return `Bearer ${(await r.json() as any).token}`;
  };
  const conv = (cc: string, userId: string) => store.createConversation({ id: cc, workspaceId: "ws_company", userId });
  const newUser = (username: string, role: "admin" | "member" = "member") => userStore.createUser({ username, password: "pw-long-enough", role });
  return { deps, store, userStore, eventBus, queues, app, login, conv, newUser, log };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });

// ── 管理端绑定（imBindings）──
describe("imBindings 管理（admin）+ resolve 幂等", () => {
  test("bind → resolve 幂等；重复 bind 不双写；unbind → 消失", async () => {
    await ctx.newUser("m1");
    const m1 = ctx.userStore.getUserByUsername("m1")!;
    const r1 = ctx.deps.imStore!.bind("tg-1001", "telegram", m1.id)!;
    expect(r1.userId).toBe(m1.id);
    expect(ctx.deps.imStore!.resolve("tg-1001", "telegram")!.userId).toBe(m1.id); // 幂等解析
    ctx.deps.imStore!.bind("tg-1001", "telegram", m1.id); // 重复绑定
    const rows = ctx.deps.imStore!.list().filter((b) => b.imUserId === "tg-1001" && b.platform === "telegram");
    expect(rows).toHaveLength(1); // 不双写
    expect(ctx.deps.imStore!.unbind("tg-1001", "telegram")).toBe(true);
    expect(ctx.deps.imStore!.resolve("tg-1001", "telegram")).toBeUndefined();
    expect(ctx.deps.imStore!.unbind("tg-1001", "telegram")).toBe(false); // 再删幂等 false
  });

  test("bind 不存在的 userId → null（不落行）", async () => {
    expect(ctx.deps.imStore!.bind("tg-x", "telegram", "u_does-not-exist")).toBeNull();
    expect(ctx.deps.imStore!.resolve("tg-x", "telegram")).toBeUndefined();
  });

  test("HTTP：member 403；admin POST/GET/DELETE 全链", async () => {
    await ctx.newUser("m1");
    await ctx.newUser("m2");
    await ctx.newUser("ad", "admin");
    const m2 = ctx.userStore.getUserByUsername("m2")!;
    const mt = await ctx.login("m1");
    const at = await ctx.login("ad");
    for (const req of [
      ctx.app.request("/im/bindings", { headers: { authorization: mt } }),
      ctx.app.request("/im/bindings", { method: "POST", headers: { ...JH, authorization: mt }, body: JSON.stringify({ imUserId: "tg-1", platform: "telegram", userId: m2.id }) }),
      ctx.app.request("/im/bindings/telegram/tg-1", { method: "DELETE", headers: { authorization: mt } }),
    ]) expect((await req).status).toBe(403);
    const bind = await ctx.app.request("/im/bindings", { method: "POST", headers: { ...JH, authorization: at }, body: JSON.stringify({ imUserId: "tg-1", platform: "telegram", userId: m2.id }) });
    expect(bind.status).toBe(200);
    expect(ctx.deps.imStore!.resolve("tg-1", "telegram")!.userId).toBe(m2.id);
    const list = await ctx.app.request("/im/bindings", { headers: { authorization: at } });
    const rows = (await list.json() as { bindings: unknown[] }).bindings;
    expect(rows).toHaveLength(1);
    const del = await ctx.app.request("/im/bindings/telegram/tg-1", { method: "DELETE", headers: { authorization: at } });
    expect(del.status).toBe(200);
    expect(ctx.deps.imStore!.resolve("tg-1", "telegram")).toBeUndefined();
  });
});

// ── 零副作用丢弃 ──
describe("入站 · 无 pending → 零副作用丢弃（决策 2/5）", () => {
  test("未绑定 IM 身份 → discarded，不落库不起轮", async () => {
    await ctx.newUser("m1");
    ctx.conv("c1", ctx.userStore.getUserByUsername("m1")!.id);
    const frames: any[] = []; ctx.eventBus.subscribe("c1", (f) => frames.push(f));
    const r = await handleImInbound(ctx.deps, { imUserId: "tg-999", platform: "telegram", text: "你好" });
    expect(r.status).toBe("discarded");
    expect(ctx.log.calls).toBe(0); // 不起轮
    expect(ctx.store.listMessages("c1")).toHaveLength(0); // 不落库
    expect(frames).toHaveLength(0); // 不推帧
  });

  test("纯 approval/task 卡命中（决策 5）→ discarded + 回发「去 Web/App 点卡」提示，不进文本回流", async () => {
    await ctx.newUser("m1");
    const m1 = ctx.userStore.getUserByUsername("m1")!;
    ctx.conv("c1", m1.id);
    ctx.deps.imStore!.bind("tg-1", "telegram", m1.id);
    ctx.store.createQuestion({ conversationId: "c1", kind: "approval", workflowId: "brand-research", input: {}, prompt: "需审批", options: ["批准", "拒绝"] });
    ctx.store.createQuestion({ conversationId: "c1", runId: null, kind: "task", prompt: "建任务卡", options: ["确认创建", "取消"], input: { displayName: "t", cron: "0 3 * * *", prompt: "p" } });
    const frames: any[] = []; ctx.eventBus.subscribe("c1", (f) => frames.push(f));
    const r = await handleImInbound(ctx.deps, { imUserId: "tg-1", platform: "telegram", text: "批准" });
    expect(r.status).toBe("discarded");
    expect(r.reply).toContain("Web/App"); // 提示去确定性通道点卡
    expect(r.conversationId).toBeUndefined();
    expect(ctx.log.calls).toBe(0); // 不起轮
    expect(ctx.store.listMessages("c1")).toHaveLength(0); // 不落库
    expect(frames).toHaveLength(0); // 不推帧
    expect(ctx.store.listQuestions("c1", { includeAnswered: true }).filter((q) => q.status === "pending")).toHaveLength(2); // 卡未动
  });

  test("队列忙 → busy（不落库不判答）", async () => {
    await ctx.newUser("m1");
    const m1 = ctx.userStore.getUserByUsername("m1")!;
    ctx.conv("c1", m1.id);
    ctx.deps.imStore!.bind("tg-1", "telegram", m1.id);
    ctx.store.createQuestion({ conversationId: "c1", runId: "r-p", prompt: "选？", options: ["A"], resumeSchema: { _t: "enum", vals: ["A"] } });
    for (let i = 0; i < 5; i++) { // 占满 HTTP 队列（MAX_HTTP_PENDING=5）
      ctx.queues.enqueueHttpTurn("c1", async () => { await delay(50); });
    }
    const r = await handleImInbound(ctx.deps, { imUserId: "tg-1", platform: "telegram", text: "A" });
    expect(r.status).toBe("busy");
    expect(ctx.store.listMessages("c1")).toHaveLength(0);
    expect(ctx.log.calls).toBe(0);
  });
});

// ── 有 pending ask → 复用内联 turn 全链 ──
describe("入站 · 有 pending ask 卡 → 内联 turn 判答收口", () => {
  test("run 绑定卡：定位会话 + 消息落库 + 注入含 [待处理提问]/[挂起工作流] + 卡 answered + hitl_answered 广播 + 回发文本", async () => {
    await ctx.newUser("m1");
    const m1 = ctx.userStore.getUserByUsername("m1")!;
    ctx.conv("c1", m1.id);
    ctx.conv("c2", m1.id);
    ctx.deps.imStore!.bind("tg-1", "telegram", m1.id);
    // 先建旧 ask 卡（低 id）验证取「最新 pending」→ 落在后建的 c2 run 绑定卡
    ctx.store.createQuestion({ conversationId: "c1", runId: null, prompt: "旧澄清", options: ["旧A"] });
    // 手动挂起态（synthetic-3step review 契约）：run + 挂起卡
    const runId = "r_pending";
    ctx.store.createRun({ runId, workflowId: "synthetic-3step", workspaceId: "ws_company", conversationId: "c2", input: {} });
    ctx.store.updateRunStatus(runId, "suspended");
    ctx.store.appendLog(runId, { stepId: "review", status: "suspended", suspendPayload: { options: ["accept", "redirect"] },
      resumeSchema: { _t: "object", shape: { decision: { _t: "enum", vals: ["accept", "redirect"] }, focus: { _t: "optional", inner: { _t: "string" } } } } });
    const qid = ctx.store.createQuestion({ conversationId: "c2", runId, prompt: "选哪个？", options: ["accept", "redirect"],
      resumeSchema: { _t: "object", shape: { decision: { _t: "enum", vals: ["accept", "redirect"] }, focus: { _t: "optional", inner: { _t: "string" } } } },
      values: [{ label: "accept", value: { decision: "accept" } }, { label: "redirect", value: { decision: "redirect" } }] });

    const frames: any[] = []; ctx.eventBus.subscribe("c2", (f) => frames.push(f));
    const r = await handleImInbound(ctx.deps, { imUserId: "tg-1", platform: "telegram", text: "选 A方案" });

    expect(r.status).toBe("processed");
    expect(r.conversationId).toBe("c2"); // 按 pending 卡自己的 conversation_id 定位（非最新会话）
    expect(r.questionId).toBe(qid);
    expect(r.messageId).toBeGreaterThan(0);
    expect(typeof r.reply === "string" && r.reply.length > 0).toBe(true); // 处理结果文本可回发（turn 输出/已答确认/简报均合格）

    expect(ctx.store.listMessages("c2").some((m) => m.role === "user" && m.content === "选 A方案")).toBe(true); // 文本进会话历史（与 Web 打字同构）

    // 本轮 chat turn 注入（#命名 auto-title 是第二次无注入 one-shot 流——按含 [待处理提问] 的元素定位，非死取 last）
    const appends = ctx.log.appends.find((a) => a.some((s) => s.startsWith("[待处理提问] 工作流")));
    expect(appends).toBeDefined();
    expect(appends!.some((s) => s.startsWith("[待处理提问] 工作流"))).toBe(true);
    expect(appends!.join(" ")).toContain("r_pending");
    expect(appends!.some((s) => s.startsWith("[挂起工作流]"))).toBe(true);

    expect(ctx.store.getQuestion(qid)!.status).toBe("answered"); // 卡 CAS 收口
    expect(frames.some((f) => f.type === "user_message" && f.content === "选 A方案")).toBe(true);
    expect(frames.some((f) => f.type === "hitl_answered" && f.questionId === qid)).toBe(true);
    expect(ctx.log.appends.filter((a) => a.length > 0)).toHaveLength(1); // 恰一轮 chat turn（auto-title 无注入段）
  });

  test("自主卡：注入引导 answer_question → 落卡 + 广播（决策 10 修订同款）", async () => {
    await ctx.newUser("m1");
    const m1 = ctx.userStore.getUserByUsername("m1")!;
    ctx.conv("c1", m1.id);
    ctx.deps.imStore!.bind("tg-1", "telegram", m1.id);
    const qid = ctx.store.createQuestion({ conversationId: "c1", runId: null, prompt: "澄清：预算区间？", options: ["<10w", ">50w"] });
    const frames: any[] = []; ctx.eventBus.subscribe("c1", (f) => frames.push(f));
    const r = await handleImInbound(ctx.deps, { imUserId: "tg-1", platform: "telegram", text: "不超过 10 万" });
    expect(r.status).toBe("processed");
    const askArr = ctx.log.appends.find((a) => a.some((s) => s.startsWith("[待处理提问] 澄清")));
    expect(askArr).toBeDefined(); // auto-title 是无注入第二流，须按含 [待处理提问] 澄清 的数组定位
    const askEl = askArr!.find((s) => s.startsWith("[待处理提问] 澄清"));
    expect(askEl).toBeDefined();
    expect(askEl!).toContain("answer_question");
    expect(ctx.store.getQuestion(qid)!.status).toBe("answered");
    expect(frames.some((f) => f.type === "hitl_answered" && f.questionId === qid)).toBe(true);
    expect(typeof r.reply === "string" && r.reply.length > 0).toBe(true);
  });
});

// ── 决策 2/5：最新 pending（kind 不限）→ 决策层分流 ──
describe("决策 2/5：查最新 pending（kind 不限），kind 分流在决策层", () => {
  test("旧 ask + 新 approval 并存 → 取最新 pending=approval → 只提示去 Web/App，不答旧 ask", async () => {
    await ctx.newUser("m1");
    const m1 = ctx.userStore.getUserByUsername("m1")!;
    ctx.conv("c1", m1.id);
    ctx.deps.imStore!.bind("tg-1", "telegram", m1.id);
    const askQid = ctx.store.createQuestion({ conversationId: "c1", runId: null, prompt: "旧澄清", options: ["旧A"] });
    ctx.store.createQuestion({ conversationId: "c1", kind: "approval", workflowId: "brand-research", input: {}, prompt: "新审批", options: ["批准", "拒绝"] }); // 后建 → 更高 id = 最新 pending
    const r = await handleImInbound(ctx.deps, { imUserId: "tg-1", platform: "telegram", text: "旧A" });
    expect(r.status).toBe("discarded"); // 最新 pending 是 approval → 不放行文本回流
    expect(r.reply).toContain("审批");
    expect(ctx.store.getQuestion(askQid)!.status).toBe("pending"); // 旧 ask 未被误答
    expect(ctx.log.calls).toBe(0);
  });
});

// ── 双端竞态：CAS 单次 ──
describe("双端竞态：Web 点卡 vs IM 内联 turn → CAS 单次执行", () => {
  async function raceSetup() {
    await ctx.newUser("m1");
    const m1 = ctx.userStore.getUserByUsername("m1")!;
    ctx.conv("c1", m1.id);
    ctx.deps.imStore!.bind("tg-1", "telegram", m1.id);
    const runId = "r_race";
    ctx.store.createRun({ runId, workflowId: "synthetic-3step", workspaceId: "ws_company", conversationId: "c1", input: {} });
    ctx.store.updateRunStatus(runId, "suspended");
    ctx.store.appendLog(runId, { stepId: "review", status: "suspended", suspendPayload: { options: ["accept", "redirect"] },
      resumeSchema: { _t: "object", shape: { decision: { _t: "enum", vals: ["accept", "redirect"] }, focus: { _t: "optional", inner: { _t: "string" } } } } });
    const qid = ctx.store.createQuestion({ conversationId: "c1", runId, prompt: "选哪个？", options: ["accept", "redirect"],
      resumeSchema: { _t: "object", shape: { decision: { _t: "enum", vals: ["accept", "redirect"] }, focus: { _t: "optional", inner: { _t: "string" } } } },
      values: [{ label: "accept", value: { decision: "accept" } }, { label: "redirect", value: { decision: "redirect" } }] });
    const frames: any[] = []; ctx.eventBus.subscribe("c1", (f) => frames.push(f));
    const token = await ctx.login("m1");
    return { runId, qid, frames, token };
  }

  test("并行：Web dispatch 与 IM 内联几乎同时 → 卡 answered 一次、hitl_answered 一条、run 不收两发", async () => {
    const { runId, qid, frames, token } = await raceSetup();
    const im = handleImInbound(ctx.deps, { imUserId: "tg-1", platform: "telegram", text: "选 A方案" });
    const web = ctx.app.request(`/conversations/c1/messages`, { method: "POST", headers: { ...JH, authorization: token }, body: JSON.stringify({ content: "accept", inReplyTo: qid }) });
    const [imR, webR] = await Promise.all([im, web]);
    expect(webR.status).toBe(202);
    expect(imR.status).toBe("processed"); // IM 文本必进 turn（消息已落）——去重由 CAS/注入收敛
    await ctx.queues.drained("c1");
    expect(ctx.store.getQuestion(qid)!.status).toBe("answered"); // 卡只 answered 一次
    expect(frames.filter((f) => f.type === "hitl_answered" && f.questionId === qid)).toHaveLength(1);
    await delayUntil(() => ctx.store.getRun(runId)!.status === "completed"); // run 只续跑一次
  });

  test("顺序 · dispatch 先胜 → IM 后至按无 pending 丢弃（幂等 ack）", async () => {
    const { runId, qid, token } = await raceSetup();
    const webR = await ctx.app.request(`/conversations/c1/messages`, { method: "POST", headers: { ...JH, authorization: token }, body: JSON.stringify({ content: "accept", inReplyTo: qid }) });
    expect(webR.status).toBe(202);
    const before = ctx.log.calls;
    const r = await handleImInbound(ctx.deps, { imUserId: "tg-1", platform: "telegram", text: "accept" });
    expect(r.status).toBe("discarded"); // 卡已答 → 无 pending → 丢弃
    expect(ctx.log.calls).toBe(before); // 零新轮
    await delayUntil(() => ctx.store.getRun(runId)!.status === "completed"); // 单次续跑
  });

  test("顺序 · IM 先胜 → Web 后点幂等 no-op（不二次 resume）", async () => {
    const { runId, qid, token } = await raceSetup();
    const r = await handleImInbound(ctx.deps, { imUserId: "tg-1", platform: "telegram", text: "accept" });
    expect(r.status).toBe("processed");
    const webR = await ctx.app.request(`/conversations/c1/messages`, { method: "POST", headers: { ...JH, authorization: token }, body: JSON.stringify({ content: "accept", inReplyTo: qid }) });
    expect(webR.status).toBe(202); // 后点幂等 ack（不 500/不二次执行）
    await ctx.queues.drained("c1");
    expect(ctx.store.getQuestion(qid)!.status).toBe("answered");
    await delayUntil(() => ctx.store.getRun(runId)!.status === "completed"); // 单次续跑
  });

  test("dispatch 直调：已答后 dispatchCardAnswer 幂等 no-op（skipTurn 不另起轮）", async () => {
    const { runId, qid } = await raceSetup();
    await ctx.store.markPendingAnsweredByRun(runId, { decision: "accept" }); // 模拟 IM 已先收口
    const r = await dispatchCardAnswer(ctx.deps, "c1", qid, "accept", ctx.userStore.getUserByUsername("m1")!.id);
    expect(r.skipTurn).toBe(true); // 已答双击 → 幂等 ack
    expect(ctx.store.getQuestion(qid)!.status).toBe("answered");
  });
});