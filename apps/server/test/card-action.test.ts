// T4（#59）：card.action.trigger 按钮回调闭环。全部在假飞书上验证（共享 codec + 真 WS）。
// seam：mapCardAction 纯函数单测 + e2e（真 deps + fakeFeishuWs + client.onCard=handleCardAction）：
//   点按钮 → 长连接 card 帧 → handleCardAction → dispatch（CAS）→ 响应（更新卡+toast）经 ack data 断言 + 落库断言。
import { describe, test, expect, afterEach } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { RunLifecycle } from "../src/runs/lifecycle";
import { ImStore } from "../src/im/store";
import { FeishuLongConnection } from "../src/im/feishu/long-connection";
import { mapCardAction, handleCardAction, answeredCardRsp } from "../src/im/feishu/card-action";
import { renderAnsweredCard, renderImCard } from "../src/im/card";
import { fakeFeishuWs, fakeFeishuFetch, cardActionEvent } from "./fake-feishu";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi, ConfiguredRunPiStream } from "../src/pi/runPi-factory";

const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await new Promise((r) => setTimeout(r, 10)); }
};

const stubRunPiFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });

describe("mapCardAction（回调 → 决策输入）", () => {
  test("正常：value={questionId,label} + operator.open_id → 解析", () => {
    expect(mapCardAction(cardActionEvent("ou_1", 7, "<10w"))).toEqual({ questionId: 7, value: "<10w", openId: "ou_1" });
  });
  test("value 缺/label 非 string → null", () => {
    expect(mapCardAction({ event: { action: { value: { questionId: 1 }, tag: "button" }, operator: { open_id: "ou" } } })).toBeNull();
    expect(mapCardAction({ event: { action: { value: { questionId: "1", value: "x" } }, operator: { open_id: "ou" } } })).toBeNull();
  });
  test("无 operator.open_id → null", () => {
    expect(mapCardAction({ event: { action: { value: { questionId: 1, value: "x" } } } })).toBeNull();
  });
});

describe("卡回调响应卡（已答态）", () => {
  test("renderAnsweredCard：无按钮 + 「✅ 已处理」（div 同形，note 已废弃）", () => {
    const card: any = renderAnsweredCard({ questionId: 1, kind: "approval", prompt: "批准？", options: [] });
    expect(card.schema).toBe("2.0");
    expect(card.body.elements.some((e: any) => e.tag === "action")).toBe(false);
    expect(card.body.elements.some((e: any) => e.tag === "note")).toBe(false);
    expect(card.body.elements.some((e: any) => e.tag === "div" && e.text?.content === "✅ 已处理")).toBe(true);
  });
  test("answeredCardRsp：toast + raw 包装卡", () => {
    const q = { id: 5, kind: "approval", prompt: "批准？" } as any;
    const rsp: any = answeredCardRsp(q, "已审批");
    expect(rsp.toast).toEqual({ type: "success", content: "已审批" });
    expect(rsp.card.type).toBe("raw"); // 飞书回调响应契约：card.type="raw" + data=卡 JSON（live smoke 修复，裸卡 → 200673）
    expect(rsp.card.data.body.elements.some((e: any) => e.tag === "note")).toBe(false); // Card 2.0 无 note
  });
});

// ── e2e：真 deps + 真 WS + 卡回调 → dispatch 落定 ──
describe("T4 e2e：按钮回调闭环（假飞书 WS）", () => {
  // 组装完整场景：full deps + fakeFeishuWs + client（onEvent=入站, onCard=handleCardAction）
  async function scene() {
    const fake = fakeFeishuWs();
    const db = openDbMigrated(":memory:");
    const store = createStores(db);
    const userStore = new UserStore(db);
    const eventBus = new EventBus();
    const queues = new ConversationQueues();
    const deps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore,
      streamRegistry: new StreamRegistry(),
      workspaceStore: new WorkspaceStore(db),
      taskStore: new ScheduledTaskStore(db, store.chat),
      eventBus, conversationQueues: queues, imStore: new ImStore(db),
      runLifecycle: new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubRunPiFactory }),
      runPiStreamFactory: (): ConfiguredRunPiStream => async (call) => ({ text: "", messages: [], toolResults: [] }),
    };
    const lc = new FeishuLongConnection({
      appId: "cli_x", appSecret: "s", baseUrl: "https://fake.feishu",
      fetchFn: fakeFeishuFetch(fake.app),
      onEvent: () => {}, // 本组测卡回调，事件不消费
      onCard: (p) => handleCardAction(deps, p),
      pingIntervalMs: 40, log: () => {},
    });
    lc.start();
    await delayUntil(() => fake.state.wsClients === 1, 3000);
    const newUser = async (u: string) => { await userStore.createUser({ username: u, password: "pw-long-enough", role: u === "ad" ? "admin" : "member" }); return userStore.getUserByUsername(u)!; };
    return { fake, deps, store, userStore, eventBus, lc, newUser };
  }

  let s!: Awaited<ReturnType<typeof scene>>;
  afterEach(() => { try { s.lc.stop(); } catch { /* 已停 */ } try { s.fake.close(); } catch { /* 已关 */ } });

  test("approval 卡点[拒绝] → 落定 deny + hitl_answered + 更新卡 + toast「已审批」", async () => {
    s = await scene();
    const m1 = await s.newUser("m1");
    s.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    s.deps.imStore!.bind("ou_1", "feishu", m1.id);
    const qid = s.store.hitl.createQuestion({ conversationId: "c1", kind: "approval", workflowId: "brand-research", input: {}, prompt: "批准本次发布？", options: ["批准", "拒绝"] });
    const frames: any[] = []; s.eventBus.subscribe("c1", (f) => frames.push(f));

    const { ack } = await s.fake.pushCardAction(cardActionEvent("ou_1", qid, "拒绝"));
    expect(ack.code).toBe(200);
    const rsp: any = ack.data;
    expect(rsp.toast.content).toBe("已审批");
    // 更新卡 = 已答态（无按钮）
    const respCard: any = rsp.card.data; // callback 响应 raw 包装 → data=卡 JSON
    expect(respCard.body.elements.some((e: any) => e.tag === "action")).toBe(false);
    expect(respCard.body.elements.some((e: any) => e.tag === "div" && String(e.text?.content).includes("已处理"))).toBe(true);
    // 落库：approval deny 已决（决策人即点击者 m1）
    const decided = s.store.hitl.getQuestion(qid)!;
    expect(decided.status).toBe("answered");
    expect(frames.some((f) => f.type === "hitl_answered" && f.questionId === qid && f.kind === "approval" && (f.answer as any).decision === "deny")).toBe(true);
  });

  test("ask run 绑定卡：点[accept] → CAS 收口 → resume → answered + hitl_answered + 响应卡", async () => {
    s = await scene();
    const m1 = await s.newUser("m1");
    s.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    s.deps.imStore!.bind("ou_1", "feishu", m1.id);
    const runId = "r_card";
    s.store.runs.createRun({ runId, workflowId: "synthetic-3step", workspaceId: "ws_company", conversationId: "c1", input: {} });
    s.store.runs.updateRunStatus(runId, "suspended");
    s.store.runs.appendLog(runId, { stepId: "review", status: "suspended", suspendPayload: { options: ["accept", "redirect"] },
      resumeSchema: { _t: "object", shape: { decision: { _t: "enum", vals: ["accept", "redirect"] }, focus: { _t: "optional", inner: { _t: "string" } } } } });
    const qid = s.store.hitl.createQuestion({ conversationId: "c1", runId, prompt: "选哪个？", options: ["accept", "redirect"],
      resumeSchema: { _t: "object", shape: { decision: { _t: "enum", vals: ["accept", "redirect"] }, focus: { _t: "optional", inner: { _t: "string" } } } },
      values: [{ label: "accept", value: { decision: "accept" } }, { label: "redirect", value: { decision: "redirect" } }] });
    const frames: any[] = []; s.eventBus.subscribe("c1", (f) => frames.push(f));

    const { ack } = await s.fake.pushCardAction(cardActionEvent("ou_1", qid, "accept"));
    expect(ack.code).toBe(200);
    expect((ack.data as any).toast.content).toBe("已处理");
    await delayUntil(() => s.store.runs.getRun(runId)!.status === "completed", 3000); // run 续跑收口
    expect(s.store.hitl.getQuestion(qid)!.status).toBe("answered");
    expect(frames.some((f) => f.type === "hitl_answered" && f.questionId === qid && (f.answer as any).decision === "accept")).toBe(true);
  });

  test("陈旧点击（已答卡）→ 幂等「该卡已被处理」+ 已答卡，不二次执行", async () => {
    s = await scene();
    const m1 = await s.newUser("m1");
    s.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    s.deps.imStore!.bind("ou_1", "feishu", m1.id);
    const qid = s.store.hitl.createQuestion({ conversationId: "c1", kind: "approval", workflowId: "brand-research", input: {}, prompt: "批准？", options: ["批准", "拒绝"] });
    s.store.hitl.markApprovalDecided(qid, { decision: "approve" }, m1.id); // 已答（模拟 Web 先处理）
    const { ack } = await s.fake.pushCardAction(cardActionEvent("ou_1", qid, "拒绝"));
    expect(ack.code).toBe(200);
    const rsp: any = ack.data;
    expect(rsp.toast).toEqual({ type: "info", content: "该卡已被处理" });
    // 未二次执行：仍是 approve 结果（deny 没发生）
    expect(s.store.hitl.getQuestion(qid)!.status).toBe("answered");
  });

  test("未绑定用户点按钮 → toast 提示绑定，不派发", async () => {
    s = await scene();
    const m1 = await s.newUser("m1");
    s.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    // 不绑定 ou_2
    const qid = s.store.hitl.createQuestion({ conversationId: "c1", kind: "approval", workflowId: "brand-research", input: {}, prompt: "批准？", options: ["批准", "拒绝"] });
    const { ack } = await s.fake.pushCardAction(cardActionEvent("ou_2", qid, "批准"));
    expect(ack.code).toBe(200);
    expect((ack.data as any).toast.type).toBe("error");
    expect(s.store.hitl.getQuestion(qid)!.status).toBe("pending"); // 未派发
  });

  test("自主 ask 卡点选 → label 命中 → 统计收口（answered + hitl_answered + 响应卡）", async () => {
    s = await scene();
    const m1 = await s.newUser("m1");
    s.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    s.deps.imStore!.bind("ou_1", "feishu", m1.id);
    const qid = s.store.hitl.createQuestion({ conversationId: "c1", runId: null, prompt: "预算？", options: ["<10w"] });
    const frames: any[] = []; s.eventBus.subscribe("c1", (f) => frames.push(f));
    const { ack } = await s.fake.pushCardAction(cardActionEvent("ou_1", qid, "<10w"));
    expect(ack.code).toBe(200);
    await delayUntil(() => s.store.hitl.getQuestion(qid)!.status === "answered", 3000);
    expect((ack.data as any).toast.content).toBe("已处理");
    expect(s.store.hitl.getQuestion(qid)!.status).toBe("answered");
    expect(frames.some((f) => f.type === "hitl_answered" && f.questionId === qid)).toBe(true);
  });

  test("T3 嵌入的按钮 value 与 T4 解析契约一致（renderImCard→handleCardAction 闭合）", async () => {
    s = await scene();
    const m1 = await s.newUser("m1");
    s.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    s.deps.imStore!.bind("ou_1", "feishu", m1.id);
    const qid = s.store.hitl.createQuestion({ conversationId: "c1", kind: "approval", workflowId: "brand-research", input: {}, prompt: "批准？", options: ["批准", "拒绝"] });
    // T3 渲染的卡 → 取按钮嵌入 value → 组点按钮事件 → T4 解析 → dispatch 生效（deny 侧，避开 registry 依赖）
    const sentCard: any = renderImCard({ questionId: qid, kind: "approval", prompt: "批准？", options: [{ label: "拒绝", value: "拒绝" }, { label: "批准", value: "批准" }] });
    const embedded = (sentCard.body.elements.find((e: any) => e.tag === "button") as any).behaviors[0].value;
    const m = mapCardAction(cardActionEvent("ou_1", embedded.questionId, embedded.value));
    expect(m).toEqual({ questionId: qid, value: "拒绝", openId: "ou_1" });
    const { ack } = await s.fake.pushCardAction(cardActionEvent("ou_1", embedded.questionId, embedded.value));
    expect((ack.data as any).toast.content).toBe("已审批");
  });
});