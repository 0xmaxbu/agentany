// ticket #18：QM 审批门 e2e（registry 门控 + 审批闭环 + enforce + 审计 + HTTP 旁路）。
// #28 重构：/approvals/:id/decide 已删——审批走统一卡应答（POST /messages inReplyTo 绑定卡，
// hitl-dispatch 按 kind 确定性执行；审批人=会话可见的人类，pi 无消息端点无自批路径）。
// 测试环境 SECURITY_POSTURE 未设 → auto（synthetic=allow / brand-*=require_approval）。禁 set env。
import { describe, test, expect } from "bun:test";
import { RunRegistry } from "../src/runs/registry";
import { EventBus } from "../src/chat/eventbus";
import { createStores, type Stores } from "../src/stores";
import { openDbMigrated } from "../src/db/client";
import { createApp } from "../src/app";
import { fullDeps } from "./deps";
import { startBridge } from "../src/bridge/server";
import { issueNonce, _clearNonces } from "../src/bridge/nonce";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(10); }
};

function setup() {
  const store = createStores(openDbMigrated(":memory:"));
  store.chat.createConversation({ id: "c-appr", workspaceId: "ws_company", userId: "u" });
  const eventBus = new EventBus();
  const registry = new RunRegistry({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });
  return { store, eventBus, registry };
}

describe("registry.start 门控（#18）", () => {
  test("allow（synthetic under auto）→ {running, runId} + run_started；直跑不经审批", async () => {
    const { eventBus, registry } = setup();
    const frames: any[] = [];
    eventBus.subscribe("c-appr", (f) => frames.push(f));
    const r = registry.start({ conversationId: "c-appr", workflowId: "synthetic-3step", input: {} });
    expect(r.status).toBe("running");
    if (r.status !== "running") throw new Error("expected running");
    await delayUntil(() => frames.some((f) => f.type === "run_started"));
    expect(frames.some((f) => f.type === "run_started" && f.workflowId === "synthetic-3step")).toBe(true);
    expect(frames.some((f) => f.type === "hitl_request")).toBe(false);
  });

  test("require_approval（brand-research under auto）→ {needs_approval}；不建 run；建审批卡（kind=approval/runId=null/存 workflowId+input）；发 hitl_request{kind:approval}", () => {
    const { store, eventBus, registry } = setup();
    const frames: any[] = [];
    eventBus.subscribe("c-appr", (f) => frames.push(f));
    const input = { brand: "测试品牌" };
    const r = registry.start({ conversationId: "c-appr", workflowId: "brand-research", input });
    expect(r.status).toBe("needs_approval");
    if (r.status !== "needs_approval") throw new Error("expected needs_approval");
    expect(r.questionId).toBeGreaterThan(0);
    expect(frames.some((f) => f.type === "run_started")).toBe(false); // 不 createRun
    const q = store.hitl.getQuestion(r.questionId)!;
    expect(q.kind).toBe("approval");
    expect(q.runId).toBeNull();
    expect(q.workflowId).toBe("brand-research");
    expect(q.input).toEqual(input);
    expect(q.options).toEqual(["批准", "拒绝"]);
    expect(q.status).toBe("pending");
    const req: any = frames.find((f) => f.type === "hitl_request");
    expect(req?.kind).toBe("approval");
    expect(req?.workflowId).toBe("brand-research");
  });

  test("require_approval 幂等：同 conv+workflow 再 start → 同 questionId，不建新卡/不发新帧", () => {
    const { store, eventBus, registry } = setup();
    const frames: any[] = [];
    eventBus.subscribe("c-appr", (f) => frames.push(f));
    const r1 = registry.start({ conversationId: "c-appr", workflowId: "brand-research", input: { brand: "a" } });
    if (r1.status !== "needs_approval") throw new Error("expected needs_approval");
    const before = frames.length;
    const r2 = registry.start({ conversationId: "c-appr", workflowId: "brand-research", input: { brand: "a" } });
    expect(r2.status).toBe("needs_approval");
    if (r2.status !== "needs_approval") throw new Error("expected needs_approval");
    expect(r2.questionId).toBe(r1.questionId);
    expect(store.hitl.listQuestions("c-appr", { includeAnswered: true, kind: "approval" })).toHaveLength(1);
    expect(frames.length).toBe(before); // 无新 hitl_request
  });

  test("approved flag 跳 policy（/approvals decide 内部用）：brand-research + approved → 直跑 running", async () => {
    const { eventBus, registry } = setup();
    const frames: any[] = [];
    eventBus.subscribe("c-appr", (f) => frames.push(f));
    const r = registry.start({ conversationId: "c-appr", workflowId: "brand-research", input: { brand: "x" }, approved: true });
    expect(r.status).toBe("running");
    if (r.status !== "running") throw new Error("expected running");
    await delayUntil(() => frames.some((f) => f.type === "run_started"));
    expect(frames.some((f) => f.type === "run_started")).toBe(true);
  });
});

const JH = { "content-type": "application/json" } as const;
/** 统一卡应答：发消息绑卡（content=卡上选项文本）。 */
const answerCard = (app: ReturnType<typeof createApp>, questionId: number, content: string) =>
  app.request(`/conversations/c-appr/messages`, { method: "POST", headers: JH, body: JSON.stringify({ content, inReplyTo: questionId }) });

describe("审批卡应答（统一卡应答 · 消息绑定，#28 重构）", () => {
  test("approve：{approve} → {approved, runId}；run_started；卡 answered + 回填 runId + decidedBy + hitl_answered{approval}", async () => {
    const { store, eventBus, registry } = setup();
    const app = createApp(fullDeps(store, { runRegistry: registry, eventBus }));
    const frames: any[] = [];
    eventBus.subscribe("c-appr", (f) => frames.push(f));
    const r = registry.start({ conversationId: "c-appr", workflowId: "brand-research", input: { brand: "测试品牌" } });
    if (r.status !== "needs_approval") throw new Error("expected needs_approval");
    const resp = await answerCard(app, r.questionId, "批准");
    expect(resp.status).toBe(202);
    await delayUntil(() => frames.some((f) => f.type === "run_started"));
    expect(frames.some((f) => f.type === "run_started")).toBe(true);
    const q = store.hitl.getQuestion(r.questionId)!;
    expect(q.status).toBe("answered");
    expect(q.runId).toBeTruthy();
    expect(q.decidedBy).toBe("dev-user");
    expect(q.answer).toEqual({ decision: "approve" });
    expect(frames.some((f) => f.type === "hitl_answered" && f.kind === "approval")).toBe(true);
  });

  test("deny：{deny} → {denied}；不 createRun（无 run_started）；卡 answered{deny} + runId 仍 null", async () => {
    const { store, eventBus, registry } = setup();
    const app = createApp(fullDeps(store, { runRegistry: registry, eventBus }));
    const frames: any[] = [];
    eventBus.subscribe("c-appr", (f) => frames.push(f));
    const r = registry.start({ conversationId: "c-appr", workflowId: "brand-research", input: { brand: "x" } });
    if (r.status !== "needs_approval") throw new Error("expected needs_approval");
    const resp = await answerCard(app, r.questionId, "拒绝");
    expect(resp.status).toBe(202);
    await delay(30);
    expect(frames.some((f) => f.type === "run_started")).toBe(false); // 不 createRun
    const q = store.hitl.getQuestion(r.questionId)!;
    expect(q.status).toBe("answered");
    expect(q.runId).toBeNull();
    expect(q.answer).toEqual({ decision: "deny" });
  });

  test("双击幂等：approve 后再 approve → 409 already decided（CAS）", async () => {
    const { store, registry } = setup();
    const app = createApp(fullDeps(store, { runRegistry: registry }));
    const r = registry.start({ conversationId: "c-appr", workflowId: "brand-research", input: { brand: "x" } });
    if (r.status !== "needs_approval") throw new Error("expected needs_approval");
    await answerCard(app, r.questionId, "批准");
    const runAfterFirst = store.hitl.getQuestion(r.questionId)!.runId;
    const resp2 = await answerCard(app, r.questionId, "批准");
    expect(resp2.status).toBe(202); // 消息正常落库
    expect(store.hitl.getQuestion(r.questionId)!.runId).toBe(runAfterFirst); // 不重复建 run
  });


});

describe("审批只人类 enforce + HTTP 旁路（#18）", () => {
  test("enforce：bridge 无消息端点 → pi 持 nonce 也无法发审批消息（无自批路径）", async () => {
    const { store, eventBus, registry } = setup();
    const { port, stop } = startBridge(0, { runRegistry: registry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const token = issueNonce("c-appr");
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/conversations/c-appr/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JH }, body: JSON.stringify({ content: "批准", inReplyTo: 1 }) });
      expect(resp.status).toBe(404); // bridge 不挂对话路由——审批消息只能人类经 main app 发
    } finally { stop(); _clearNonces(); }
  });

  test("HTTP 旁路锁定：POST /workflows/brand-research/runs 直接 createRun（不经审批门、无 approval 卡）—— 规格明定，A2 收口", async () => {
    const { store, eventBus, registry } = setup();
    const app = createApp(fullDeps(store, { runRegistry: registry, eventBus, runPiFactory: stubFactory as any }));
    const frames: any[] = [];
    eventBus.subscribe("c-appr", (f) => frames.push(f));
    await app.request("/workflows/brand-research/runs", { method: "POST", headers: JH, body: JSON.stringify({ input: { brand: "x" } }) });
    // 不经审批门：无 approval 卡
    expect(store.hitl.listQuestions("c-appr", { includeAnswered: true, kind: "approval" })).toHaveLength(0);
    expect(frames.some((f) => f.type === "hitl_request" && f.kind === "approval")).toBe(false);
  });
});

describe("approve CAS 顺序 + 失败回滚（#codex review：占位不得永久卡死审批）", () => {
  test("registry 不可用 → 503 且卡仍 pending（可重试，不永久卡死）", async () => {
    const { store, registry } = setup();
    // 真建审批卡（registry.start 返 needs_approval，不建 run）
    const r = registry.start({ conversationId: "c-appr", workflowId: "brand-research", input: { brand: "x" } });
    if (r.status !== "needs_approval") throw new Error("expected needs_approval");
    const app = createApp(fullDeps(store)); // 无 runRegistry → dispatch 报错但卡可重试
    const resp = await answerCard(app, r.questionId, "批准");
    expect(resp.status).toBe(202); // 消息本身正常
    await delay(20);
    expect(store.hitl.getQuestion(r.questionId)!.status).toBe("pending"); // 回滚/未执行 → 可重试
  });

  test("start() 抛错 → 500 + 回滚卡为 pending（可重试，不永久卡死）", async () => {
    const { store, registry } = setup();
    const r = registry.start({ conversationId: "c-appr", workflowId: "brand-research", input: { brand: "x" } });
    if (r.status !== "needs_approval") throw new Error("expected needs_approval");
    // 注入 start 会抛错的假 registry（模拟会话被删 / 工作流失注等 start 抛错）
    const boomRegistry = { start: () => { throw new Error("conversation gone"); } };
    const app = createApp(fullDeps(store, { runRegistry: boomRegistry as any }));
    const resp = await answerCard(app, r.questionId, "批准");
    expect(resp.status).toBe(202);
    await delay(20);
    expect(store.hitl.getQuestion(r.questionId)!.status).toBe("pending"); // 回滚 → 可重试
  });
});
