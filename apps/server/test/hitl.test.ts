// ticket #16：HITL 闭环（ask_user 异步 + 判答融入 turn + resume 幂等首答 + 前端卡 + 刷新恢复）。
// 本文件：store HITL 方法 CRUD 单测（步骤1）+ bridge /ask_user + /run/resume 端到端（步骤6 补）。
import { describe, test, expect } from "bun:test";
import { createStores, type Stores } from "../src/stores";
import { openDbMigrated } from "../src/db/client";
import { startBridge } from "../src/bridge/server";
import { createApp } from "../src/app";
import { fullDeps } from "./deps";
import { issueNonce, _clearNonces } from "../src/bridge/nonce";
import { RunLifecycle } from "../src/runs/lifecycle";
import { EventBus } from "../src/chat/eventbus";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(10); }
};
// synthetic under auto → {running}；窄化 r.runId（#18 StartResult 联合）。
async function startHitl(registry: RunLifecycle, conv = "c-hitl") {
  const r = await registry.start({ conversationId: conv, workflowId: "synthetic-3step", input: {} });
  if (r.status !== "running") throw new Error(`expected running, got ${r.status}`);
  return r;
}
function bridgeSetup() {
  const store = createStores(openDbMigrated(":memory:"));
  store.chat.createConversation({ id: "c-hitl", workspaceId: "ws_company", userId: "u" });
  const eventBus = new EventBus();
  const registry = new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });
  return { store, eventBus, registry };
}
const JH = { "content-type": "application/json" } as const;
const askUser = (port: number, token: string, runId: string, prompt = "选哪个？", options = ["accept", "redirect"]) =>
  fetch(`http://127.0.0.1:${port}/ask_user`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JH }, body: JSON.stringify({ runId, prompt, options }) });
const resumeRun = (port: number, token: string, runId: string, resumeData: unknown) =>
  fetch(`http://127.0.0.1:${port}/run/resume`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JH }, body: JSON.stringify({ runId, resumeData }) });

function newStore(conv = "c1") {
  const store = createStores(openDbMigrated(":memory:"));
  store.chat.createConversation({ id: conv, workspaceId: "ws_company", userId: "u" });
  return store;
}

describe("store · HITL question CRUD（#16 步骤1）", () => {
  test("createQuestion → listQuestions/getQuestion；pending 过滤 + options 反序列化", () => {
    const store = newStore();
    const id = store.hitl.createQuestion({
      conversationId: "c1", runId: "r1", prompt: "选哪个？", options: ["A", "B"],
      resumeSchema: { _t: "enum", vals: ["A", "B"] },
    });
    expect(id).toBeGreaterThan(0);
    const pending = store.hitl.listQuestions("c1", { includeAnswered: false });
    expect(pending).toHaveLength(1);
    expect(pending[0].prompt).toBe("选哪个？");
    expect(pending[0].options).toEqual(["A", "B"]); // 反序列化回 string[]
    expect(pending[0].resumeSchema).toEqual({ _t: "enum", vals: ["A", "B"] });
    expect(pending[0].status).toBe("pending");
    expect(store.hitl.getQuestion(id)?.runId).toBe("r1");
  });

  test("getPendingByRun + markPendingAnsweredByRun（answer 反序列化、answeredAt 落、pending 清）", () => {
    const store = newStore();
    store.hitl.createQuestion({ conversationId: "c1", runId: "r1", prompt: "q", options: ["A"] });
    expect(store.hitl.getPendingByRun("r1")?.status).toBe("pending");
    expect(store.hitl.getPendingByRun("r2")).toBeUndefined();
    const row = store.hitl.markPendingAnsweredByRun("r1", { decision: "A" });
    expect(row?.status).toBe("answered");
    expect(row?.answer).toEqual({ decision: "A" });
    expect(row?.answeredAt).toBeTruthy();
    expect(store.hitl.getPendingByRun("r1")).toBeUndefined(); // 已 answered → 不再 pending
    expect(store.hitl.listQuestions("c1", { includeAnswered: true })).toHaveLength(1);
    expect(store.hitl.listQuestions("c1", { includeAnswered: false })).toHaveLength(0);
  });

  test("listQuestions 按 id 排序 + 跨会话隔离", () => {
    const store = newStore();
    store.chat.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u" });
    store.hitl.createQuestion({ conversationId: "c1", runId: "r1", prompt: "q1", options: [] });
    store.hitl.createQuestion({ conversationId: "c1", runId: "r2", prompt: "q2", options: [] });
    store.hitl.createQuestion({ conversationId: "c2", runId: "r3", prompt: "q3", options: [] });
    expect(store.hitl.listQuestions("c1", { includeAnswered: true }).map((q) => q.runId)).toEqual(["r1", "r2"]);
    expect(store.hitl.listQuestions("c2", { includeAnswered: true }).map((q) => q.runId)).toEqual(["r3"]);
  });

  test("markPendingAnsweredByRun 无 pending → undefined（不抛）", () => {
    const store = newStore();
    expect(store.hitl.markPendingAnsweredByRun("nope", { x: 1 })).toBeUndefined();
  });
});

describe("store · 审批 question（#18）", () => {
  test("createQuestion kind=approval + runId 可空 + workflowId/input 落；listQuestions kind 过滤；ask 默认 kind", () => {
    const store = newStore();
    store.hitl.createQuestion({ conversationId: "c1", runId: "r1", prompt: "q-ask", options: ["A"] }); // 旧式 ask 卡
    const aid = store.hitl.createQuestion({
      conversationId: "c1", runId: null, kind: "approval", workflowId: "brand-research",
      input: { topic: "x" }, prompt: "批准？", options: ["批准", "拒绝"],
    });
    expect(aid).toBeGreaterThan(0);
    const all = store.hitl.listQuestions("c1", { includeAnswered: true });
    expect(all).toHaveLength(2);
    const ap = all.find((q) => q.id === aid)!;
    expect(ap.kind).toBe("approval");
    expect(ap.runId).toBeNull();
    expect(ap.workflowId).toBe("brand-research");
    expect(ap.input).toEqual({ topic: "x" });
    expect(all.find((q) => q.id !== aid)?.kind).toBe("ask"); // 旧式默认 ask
    expect(store.hitl.listQuestions("c1", { includeAnswered: true, kind: "approval" }).map((q) => q.id)).toEqual([aid]);
    expect(store.hitl.listQuestions("c1", { includeAnswered: true, kind: "ask" })).toHaveLength(1);
  });

  test("getPendingApproval(convId, workflowId)：返该 conv+workflow 的 pending 审批卡", () => {
    const store = newStore();
    store.hitl.createQuestion({ conversationId: "c1", runId: null, kind: "approval", workflowId: "brand-research", input: {}, prompt: "p", options: ["批准", "拒绝"] });
    store.hitl.createQuestion({ conversationId: "c1", runId: null, kind: "approval", workflowId: "brand-strategy-analysis", input: {}, prompt: "p", options: ["批准", "拒绝"] });
    expect(store.hitl.getPendingApproval("c1", "brand-research")?.workflowId).toBe("brand-research");
    expect(store.hitl.getPendingApproval("c1", "brand-research")?.status).toBe("pending");
    expect(store.hitl.getPendingApproval("c1", "synthetic-3step")).toBeUndefined();
  });

  test("markApprovalDecided：CAS 标 answered + 回填 runId/decidedBy；非 pending → undefined（幂等）", () => {
    const store = newStore();
    const id = store.hitl.createQuestion({ conversationId: "c1", runId: null, kind: "approval", workflowId: "brand-research", input: {}, prompt: "p", options: ["批准", "拒绝"] });
    const approved = store.hitl.markApprovalDecided(id, { decision: "approve" }, "u-qm", "r_new123");
    expect(approved?.status).toBe("answered");
    expect(approved?.answer).toEqual({ decision: "approve" });
    expect(approved?.runId).toBe("r_new123"); // 回填
    expect(approved?.decidedBy).toBe("u-qm");
    expect(approved?.answeredAt).toBeTruthy();
    expect(store.hitl.markApprovalDecided(id, { decision: "deny" }, "u-qm")).toBeUndefined(); // 已 answered → CAS 挡
  });
});

describe("bridge /ask_user + /run/resume（#16 步骤2 端到端）", () => {
  test("挂起 → 引擎同事务直建强制卡；/ask_user 带 runId → 400（run 绑定卡归引擎，bridge 仅自主卡）", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runLifecycle: registry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    try {
const r = await startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      await delayUntil(() => frames.some((f) => f.type === "hitl_request")); // ADR-0025 决策 6：挂起即直建卡
      const engReq: any = frames.find((f) => f.type === "hitl_request");
      expect(engReq.kind).toBe("ask");
      expect(engReq.options).toEqual(["接受", "偏移 +1 重跑"]); // synthetic ask 步显式 options
      expect(engReq.resumeSchema).toBeTruthy();

      const resp = await askUser(port, token, r.runId); // 旧「补卡」路径已退役 → 拒绝
      expect(resp.status).toBe(400);
      expect(store.hitl.listQuestions("c-hitl", { includeAnswered: true })).toHaveLength(1); // 不建第二卡
      expect(store.hitl.getPendingByRun(r.runId)?.kind).toBe("ask");
    } finally { stop(); _clearNonces(); }
  });

  test("/ask_user 自主（#47/T5）：无 runId → 自主卡（runId null，无 resume 语义）", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runLifecycle: registry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/ask_user`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "澄清：目标预算区间？", options: ["<10w", "10-50w", ">50w"] }),
      });
      expect(resp.status).toBe(200);
      const data: any = await resp.json();
      expect(data.status).toBe("asked");
      // 自主卡：runId 空、无 resume 语义（点选将滑 LLM 轮——dispatch 层另行覆盖）
      const q = store.hitl.getQuestion(data.questionId)!;
      expect(q.runId).toBeNull();
      expect(q.kind).toBe("ask");
      const req: any = frames.find((f) => f.type === "hitl_request");
      expect(req.runId).toBeNull();
      expect(req.options).toEqual(["<10w", "10-50w", ">50w"]);
    } finally { stop(); _clearNonces(); }
  });

  test("/run/resume 首答: accept → completed + markAnswered + hitl_answered", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runLifecycle: registry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    try {
const r = await startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      const resp = await resumeRun(port, token, r.runId, { decision: "accept" });
      expect(resp.status).toBe(200);
      expect((await resp.json() as any).status).toBe("running"); // ADR-0025 决策 11：即时 verdict，续跑 detached
      await delayUntil(() => frames.some((f) => f.type === "hitl_answered"));
      expect(frames.some((f) => f.type === "hitl_answered" && (f.answer as any)?.decision === "accept")).toBe(true);
      await delayUntil(() => frames.some((f) => f.type === "run_completed")); // detached 续跑完成（registry clean 发）
      expect(frames.some((f) => f.type === "run_completed")).toBe(true);
      expect(store.hitl.getPendingByRun(r.runId)).toBeUndefined(); // answered
      const q = store.hitl.listQuestions("c-hitl", { includeAnswered: true })[0];
      expect(q.status).toBe("answered");
      expect(q.answer).toEqual({ decision: "accept" });
    } finally { stop(); _clearNonces(); }
  });

  test("/run/resume 幂等: 首答后再 resume → alreadyAnswered，不重复 mark", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runLifecycle: registry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    try {
const r = await startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      await resumeRun(port, token, r.runId, { decision: "accept" });
      await delayUntil(() => frames.some((f) => f.type === "hitl_answered"));
      const beforeAns = frames.filter((f) => f.type === "hitl_answered").length;
      const r2 = await resumeRun(port, token, r.runId, { decision: "accept" });
      expect(r2.status).toBe(200);
      expect((await r2.json() as any).alreadyAnswered).toBe(true);
      await delay(20);
      expect(frames.filter((f) => f.type === "hitl_answered").length).toBe(beforeAns); // 无新帧
    } finally { stop(); _clearNonces(); }
  });
});

describe("bridge /ask_user + /run/resume · guard 与边界（#16）", () => {
  test("/ask_user 带 runId → 400（run 绑定卡归引擎直建；suspended/running/他 conv 一律拒）", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    store.runs.createRun({ runId: "r-run", workflowId: "synthetic-3step", workspaceId: "ws_company", conversationId: "c-hitl", input: {} }); // 默认 running
    const { port, stop } = startBridge(0, { runLifecycle: registry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const token = issueNonce("c-hitl");
    try {
      const resp = await askUser(port, token, "r-run");
      expect(resp.status).toBe(400); // 旧「runId 补卡」路径已退役（ADR-0025 决策 7 严格执行）
      expect(((await resp.json()) as any).error).toContain("engine");
    } finally { stop(); _clearNonces(); }
  });

  test("/run/resume rejected: 坏 schema → 409，question 保持 pending、run 不推进", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runLifecycle: registry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const token = issueNonce("c-hitl");
    try {
const r = await startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      const resp = await resumeRun(port, token, r.runId, { decision: "bogus" }); // 不在 enum
      expect(resp.status).toBe(409);
      expect(store.hitl.getPendingByRun(r.runId)?.status).toBe("pending"); // 保持 pending
      expect(registry.read(r.runId)?.status).toBe("suspended"); // run 未推进
    } finally { stop(); _clearNonces(); }
  });

  test("/ask_answer（决策 10 修订）：自主卡打字答案经 pi 归一化落卡 → answered + hitl_answered", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runLifecycle: registry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    const qid = store.hitl.createQuestion({ conversationId: "c-hitl", runId: null, prompt: "澄清：预算？", options: ["<10w", ">50w"] });
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/ask_answer`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, ...JH },
        body: JSON.stringify({ questionId: qid, answer: { budget: "8w" } }), // pi 归一化产物
      });
      expect(resp.status).toBe(200);
      expect((await resp.json() as any).status).toBe("answered");
      const q = store.hitl.getQuestion(qid)!;
      expect(q.status).toBe("answered");
      expect(q.answer).toEqual({ budget: "8w" });
      expect(frames.some((f) => f.type === "hitl_answered" && f.questionId === qid && (f.answer as any).budget === "8w")).toBe(true);

      const again = await fetch(`http://127.0.0.1:${port}/ask_answer`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, ...JH },
        body: JSON.stringify({ questionId: qid, answer: "x" }),
      });
      expect((await again.json() as any).status).toBe("alreadyAnswered"); // 幂等
    } finally { stop(); _clearNonces(); }
  });

  test("/ask_answer guard：run 绑定卡 → 409（那是 resume_workflow 职责）；跨会话/不存在 → 404", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    store.chat.createConversation({ id: "c-other", workspaceId: "ws_company", userId: "u" });
    const bound = store.hitl.createQuestion({ conversationId: "c-hitl", runId: "r-bound", prompt: "q", options: ["a"] });
    const other = store.hitl.createQuestion({ conversationId: "c-other", runId: null, prompt: "q", options: ["a"] });
    const { port, stop } = startBridge(0, { runLifecycle: registry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const token = issueNonce("c-hitl"); // c-hitl 的 nonce
    try {
      const r1 = await fetch(`http://127.0.0.1:${port}/ask_answer`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JH }, body: JSON.stringify({ questionId: bound, answer: "a" }) });
      expect(r1.status).toBe(409); // run 绑定卡走 resume_workflow
      const r2 = await fetch(`http://127.0.0.1:${port}/ask_answer`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JH }, body: JSON.stringify({ questionId: other, answer: "a" }) });
      expect(r2.status).toBe(404); // 他会话的卡（nonce 只授权本会话）
      const r3 = await fetch(`http://127.0.0.1:${port}/ask_answer`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JH }, body: JSON.stringify({ questionId: 99999, answer: "a" }) });
      expect(r3.status).toBe(404);
    } finally { stop(); _clearNonces(); }
  });

  test("redirect 循环: resume redirect → 引擎自动再建强制卡 q2 → q1 answered + q2 pending（不重复卡）", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runLifecycle: registry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    try {
const r = await startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      await delayUntil(() => frames.some((f) => f.type === "hitl_request")); // 引擎卡 q1 已直建
      const q1id = frames.find((f) => f.type === "hitl_request").questionId as number;

      const resp = await resumeRun(port, token, r.runId, { decision: "redirect" });
      expect(resp.status).toBe(200);
      expect((await resp.json() as any).status).toBe("running"); // ADR-0025 决策 11：即时 verdict（回 s1→review 再 suspend 是后续）
      await delayUntil(() => registry.read(r.runId)?.status === "suspended"); // 循环再挂起
      await delayUntil(() => store.hitl.getQuestion(q1id)!.status === "answered"); // q1 answered

      const q2 = store.hitl.getPendingByRun(r.runId)!; // 引擎循环再直建 q2（含 redirect 的显式 value 快照）
      expect(q2.kind).toBe("ask");
      expect(q2.options).toEqual(["接受", "偏移 +1 重跑"]);
      expect((q2.values as any[])[1].value).toEqual({ decision: "redirect" }); // 快照不失效
      const ask2 = await askUser(port, token, r.runId); // 带 runId → 400（不建第三卡）
      expect(ask2.status).toBe(400);
      expect(store.hitl.listQuestions("c-hitl", { includeAnswered: true })).toHaveLength(2); // q1 answered + q2 pending
    } finally { stop(); _clearNonces(); }
  });
});

describe("GET /conversations/:id/hitl · 刷新恢复（#16）", () => {
  test("返回 pending + answered（按 id 排）；ask 卡的决策辅助 context 一并透出", async () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.hitl.createQuestion({ conversationId: "c1", runId: "r1", prompt: "q1", options: ["A"], context: "## 候选对比\nA 更稳" }); // ADR-0030 决策 3：context 一等列（退役 input-as-{context} 走私）
    store.hitl.createQuestion({ conversationId: "c1", runId: "r2", prompt: "q2", options: ["B"] });
    store.hitl.markPendingAnsweredByRun("r2", { decision: "B" });
    const app = createApp(fullDeps(store));
    const resp = await app.request("/conversations/c1/hitl");
    expect(resp.status).toBe(200);
    const list: any = await resp.json();
    expect(list).toHaveLength(2);
    expect(list.map((q: any) => q.runId)).toEqual(["r1", "r2"]);
    expect(list[0].status).toBe("pending");
    expect(list[0].context).toBe("## 候选对比\nA 更稳"); // context 一等列直读（前端渲染归后续）
    expect(list[1].status).toBe("answered");
    expect(list[1].answer).toEqual({ decision: "B" });
  });

  test("会话不存在 → 404", async () => {
    const store = createStores(openDbMigrated(":memory:"));
    const app = createApp(fullDeps(store));
    expect((await app.request("/conversations/nope/hitl")).status).toBe(404);
  });
});

describe("POST /conversations/:id/abort（#19）", () => {
  test("停该会话 running run → {aborted:false, stopped:N}；run 置 failed", async () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.runs.createRun({ runId: "r-run", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} }); // running，无句柄
    const eventBus = new EventBus();
    const registry = new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });
    const app = createApp(fullDeps(store, { runLifecycle: registry, eventBus }));
    const resp = await app.request("/conversations/c1/abort", { method: "POST" });
    expect(resp.status).toBe(200);
    const data: any = await resp.json();
    expect(data.aborted).toBe(false); // 无 turn 在跑
    expect(data.stopped).toBe(1); // 停了 1 个 run
    expect(store.runs.getRun("r-run")!.status).toBe("failed");
  });

  test("会话不存在 → 404", async () => {
    const store = createStores(openDbMigrated(":memory:"));
    const app = createApp(fullDeps(store));
    expect((await app.request("/conversations/nope/abort", { method: "POST" })).status).toBe(404);
  });
});
