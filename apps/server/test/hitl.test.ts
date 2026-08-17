// ticket #16：HITL 闭环（ask_user 异步 + 判答融入 turn + resume 幂等首答 + 前端卡 + 刷新恢复）。
// 本文件：store HITL 方法 CRUD 单测（步骤1）+ bridge /ask_user + /run/resume 端到端（步骤6 补）。
import { describe, test, expect } from "bun:test";
import { WorkflowStore } from "../src/workflow-engine/store";
import { openDbMigrated } from "../src/db/client";
import { startBridge } from "../src/bridge/server";
import { createApp } from "../src/app";
import { fullDeps } from "./deps";
import { issueNonce, _clearNonces } from "../src/bridge/nonce";
import { RunRegistry } from "../src/runs/registry";
import { EventBus } from "../src/chat/eventbus";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(10); }
};
// synthetic under auto → {running}；窄化 r.runId（#18 StartOutcome 联合）。
function startHitl(registry: RunRegistry, conv = "c-hitl") {
  const r = registry.start({ conversationId: conv, workflowId: "synthetic-3step", input: {} });
  if (r.status !== "running") throw new Error(`expected running, got ${r.status}`);
  return r;
}
function bridgeSetup() {
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  store.createConversation({ id: "c-hitl", workspaceId: "ws_company", userId: "u" });
  const eventBus = new EventBus();
  const registry = new RunRegistry({ store, eventBus, runPiFactory: stubFactory });
  return { store, eventBus, registry };
}
const JH = { "content-type": "application/json" } as const;
const askUser = (port: number, token: string, runId: string, prompt = "选哪个？", options = ["accept", "redirect"]) =>
  fetch(`http://127.0.0.1:${port}/ask_user`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JH }, body: JSON.stringify({ runId, prompt, options }) });
const resumeRun = (port: number, token: string, runId: string, resumeData: unknown) =>
  fetch(`http://127.0.0.1:${port}/run/resume`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JH }, body: JSON.stringify({ runId, resumeData }) });

function newStore(conv = "c1") {
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  store.createConversation({ id: conv, workspaceId: "ws_company", userId: "u" });
  return store;
}

describe("store · HITL question CRUD（#16 步骤1）", () => {
  test("createQuestion → listQuestions/getQuestion；pending 过滤 + options 反序列化", () => {
    const store = newStore();
    const id = store.createQuestion({
      conversationId: "c1", runId: "r1", prompt: "选哪个？", options: ["A", "B"],
      resumeSchema: { _t: "enum", vals: ["A", "B"] },
    });
    expect(id).toBeGreaterThan(0);
    const pending = store.listQuestions("c1", { includeAnswered: false });
    expect(pending).toHaveLength(1);
    expect(pending[0].prompt).toBe("选哪个？");
    expect(pending[0].options).toEqual(["A", "B"]); // 反序列化回 string[]
    expect(pending[0].resumeSchema).toEqual({ _t: "enum", vals: ["A", "B"] });
    expect(pending[0].status).toBe("pending");
    expect(store.getQuestion(id)?.runId).toBe("r1");
  });

  test("getPendingByRun + markPendingAnsweredByRun（answer 反序列化、answeredAt 落、pending 清）", () => {
    const store = newStore();
    store.createQuestion({ conversationId: "c1", runId: "r1", prompt: "q", options: ["A"] });
    expect(store.getPendingByRun("r1")?.status).toBe("pending");
    expect(store.getPendingByRun("r2")).toBeUndefined();
    const row = store.markPendingAnsweredByRun("r1", { decision: "A" });
    expect(row?.status).toBe("answered");
    expect(row?.answer).toEqual({ decision: "A" });
    expect(row?.answeredAt).toBeTruthy();
    expect(store.getPendingByRun("r1")).toBeUndefined(); // 已 answered → 不再 pending
    expect(store.listQuestions("c1", { includeAnswered: true })).toHaveLength(1);
    expect(store.listQuestions("c1", { includeAnswered: false })).toHaveLength(0);
  });

  test("listQuestions 按 id 排序 + 跨会话隔离", () => {
    const store = newStore();
    store.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u" });
    store.createQuestion({ conversationId: "c1", runId: "r1", prompt: "q1", options: [] });
    store.createQuestion({ conversationId: "c1", runId: "r2", prompt: "q2", options: [] });
    store.createQuestion({ conversationId: "c2", runId: "r3", prompt: "q3", options: [] });
    expect(store.listQuestions("c1", { includeAnswered: true }).map((q) => q.runId)).toEqual(["r1", "r2"]);
    expect(store.listQuestions("c2", { includeAnswered: true }).map((q) => q.runId)).toEqual(["r3"]);
  });

  test("markPendingAnsweredByRun 无 pending → undefined（不抛）", () => {
    const store = newStore();
    expect(store.markPendingAnsweredByRun("nope", { x: 1 })).toBeUndefined();
  });
});

describe("store · 审批 question（#18）", () => {
  test("createQuestion kind=approval + runId 可空 + workflowId/input 落；listQuestions kind 过滤；ask 默认 kind", () => {
    const store = newStore();
    store.createQuestion({ conversationId: "c1", runId: "r1", prompt: "q-ask", options: ["A"] }); // 旧式 ask 卡
    const aid = store.createQuestion({
      conversationId: "c1", runId: null, kind: "approval", workflowId: "brand-research",
      input: { topic: "x" }, prompt: "批准？", options: ["批准", "拒绝"],
    });
    expect(aid).toBeGreaterThan(0);
    const all = store.listQuestions("c1", { includeAnswered: true });
    expect(all).toHaveLength(2);
    const ap = all.find((q) => q.id === aid)!;
    expect(ap.kind).toBe("approval");
    expect(ap.runId).toBeNull();
    expect(ap.workflowId).toBe("brand-research");
    expect(ap.input).toEqual({ topic: "x" });
    expect(all.find((q) => q.id !== aid)?.kind).toBe("ask"); // 旧式默认 ask
    expect(store.listQuestions("c1", { includeAnswered: true, kind: "approval" }).map((q) => q.id)).toEqual([aid]);
    expect(store.listQuestions("c1", { includeAnswered: true, kind: "ask" })).toHaveLength(1);
  });

  test("getPendingApproval(convId, workflowId)：返该 conv+workflow 的 pending 审批卡", () => {
    const store = newStore();
    store.createQuestion({ conversationId: "c1", runId: null, kind: "approval", workflowId: "brand-research", input: {}, prompt: "p", options: ["批准", "拒绝"] });
    store.createQuestion({ conversationId: "c1", runId: null, kind: "approval", workflowId: "brand-strategy-analysis", input: {}, prompt: "p", options: ["批准", "拒绝"] });
    expect(store.getPendingApproval("c1", "brand-research")?.workflowId).toBe("brand-research");
    expect(store.getPendingApproval("c1", "brand-research")?.status).toBe("pending");
    expect(store.getPendingApproval("c1", "synthetic-3step")).toBeUndefined();
  });

  test("markApprovalDecided：CAS 标 answered + 回填 runId/decidedBy；非 pending → undefined（幂等）", () => {
    const store = newStore();
    const id = store.createQuestion({ conversationId: "c1", runId: null, kind: "approval", workflowId: "brand-research", input: {}, prompt: "p", options: ["批准", "拒绝"] });
    const approved = store.markApprovalDecided(id, { decision: "approve" }, "u-qm", "r_new123");
    expect(approved?.status).toBe("answered");
    expect(approved?.answer).toEqual({ decision: "approve" });
    expect(approved?.runId).toBe("r_new123"); // 回填
    expect(approved?.decidedBy).toBe("u-qm");
    expect(approved?.answeredAt).toBeTruthy();
    expect(store.markApprovalDecided(id, { decision: "deny" }, "u-qm")).toBeUndefined(); // 已 answered → CAS 挡
  });
});

describe("bridge /ask_user + /run/resume（#16 步骤2 端到端）", () => {
  test("/ask_user happy: suspended run → asked + hitl_request + resumeSchema 自动取 + DB pending", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    try {
      const r = startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      const resp = await askUser(port, token, r.runId);
      expect(resp.status).toBe(200);
      const data: any = await resp.json();
      expect(data.status).toBe("asked");
      expect(data.questionId).toBeGreaterThan(0);
      await delayUntil(() => frames.some((f) => f.type === "hitl_request"));
      const req: any = frames.find((f) => f.type === "hitl_request");
      expect(req.runId).toBe(r.runId);
      expect(req.options).toEqual(["accept", "redirect"]);
      expect(req.resumeSchema).toBeTruthy(); // 自动取（synthetic review 的 enum 手搓 schema）
      expect(store.getPendingByRun(r.runId)?.prompt).toBe("选哪个？");
    } finally { stop(); _clearNonces(); }
  });

  test("/ask_user 幂等: 同 run 再问 → already_asked（不重复建、无新帧）", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    try {
      const r = startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      const r1 = await (await askUser(port, token, r.runId)).json() as any;
      await delayUntil(() => frames.some((f) => f.type === "hitl_request"));
      const before = frames.length;
      const r2 = await (await askUser(port, token, r.runId)).json() as any;
      expect(r2.status).toBe("already_asked");
      expect(r2.questionId).toBe(r1.questionId); // 同一 question
      expect(store.listQuestions("c-hitl", { includeAnswered: true })).toHaveLength(1);
      await delay(20);
      expect(frames.length).toBe(before); // 无新 hitl_request
    } finally { stop(); _clearNonces(); }
  });

  test("/run/resume 首答: accept → completed + markAnswered + hitl_answered", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    try {
      const r = startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      await askUser(port, token, r.runId);
      const resp = await resumeRun(port, token, r.runId, { decision: "accept" });
      expect(resp.status).toBe(200);
      expect((await resp.json() as any).status).toBe("running"); // ADR-0025 决策 11：即时 verdict，续跑 detached
      await delayUntil(() => frames.some((f) => f.type === "hitl_answered"));
      expect(frames.some((f) => f.type === "hitl_answered" && (f.answer as any)?.decision === "accept")).toBe(true);
      await delayUntil(() => frames.some((f) => f.type === "run_completed")); // detached 续跑完成（registry clean 发）
      expect(frames.some((f) => f.type === "run_completed")).toBe(true);
      expect(store.getPendingByRun(r.runId)).toBeUndefined(); // answered
      const q = store.listQuestions("c-hitl", { includeAnswered: true })[0];
      expect(q.status).toBe("answered");
      expect(q.answer).toEqual({ decision: "accept" });
    } finally { stop(); _clearNonces(); }
  });

  test("/run/resume 幂等: 首答后再 resume → alreadyAnswered，不重复 mark", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    try {
      const r = startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      await askUser(port, token, r.runId);
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
  test("/ask_user 状态 guard: run 非 suspended → 409", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    store.createRun({ runId: "r-run", workflowId: "synthetic-3step", workspaceId: "ws_company", conversationId: "c-hitl", input: {} }); // 默认 running
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-hitl");
    try {
      const resp = await askUser(port, token, "r-run");
      expect(resp.status).toBe(409);
    } finally { stop(); _clearNonces(); }
  });

  test("/ask_user 跨会话 guard: run 属别的会话 → 403", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    store.createConversation({ id: "c-other", workspaceId: "ws_company", userId: "u" });
    store.createRun({ runId: "r-other", workflowId: "synthetic-3step", workspaceId: "ws_company", conversationId: "c-other", input: {} });
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-hitl"); // c-hitl 的 nonce
    try {
      const resp = await askUser(port, token, "r-other"); // run 属 c-other
      expect(resp.status).toBe(403);
    } finally { stop(); _clearNonces(); }
  });

  test("/run/resume rejected: 坏 schema → 409，question 保持 pending、run 不推进", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-hitl");
    try {
      const r = startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      await askUser(port, token, r.runId);
      const resp = await resumeRun(port, token, r.runId, { decision: "bogus" }); // 不在 enum
      expect(resp.status).toBe(409);
      expect(store.getPendingByRun(r.runId)?.status).toBe("pending"); // 保持 pending
      expect(registry.read(r.runId)?.status).toBe("suspended"); // run 未推进
    } finally { stop(); _clearNonces(); }
  });

  test("redirect 循环: resume redirect → run 再 suspend + q1 answered + 可建 q2", async () => {
    const { store, eventBus, registry } = bridgeSetup();
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-hitl");
    const frames: any[] = [];
    eventBus.subscribe("c-hitl", (f) => frames.push(f));
    try {
      const r = startHitl(registry);
      await delayUntil(() => registry.read(r.runId)?.status === "suspended");
      await askUser(port, token, r.runId);
      const resp = await resumeRun(port, token, r.runId, { decision: "redirect" });
      expect(resp.status).toBe(200);
      expect((await resp.json() as any).status).toBe("running"); // ADR-0025 决策 11：即时 verdict（回 s1→review 再 suspend 是后续）
      await delayUntil(() => registry.read(r.runId)?.status === "suspended"); // 循环再挂起
      await delayUntil(() => frames.some((f) => f.type === "hitl_answered")); // q1 answered
      expect(store.listQuestions("c-hitl", { includeAnswered: true }).filter((q) => q.status === "answered")).toHaveLength(1);
      expect(store.getPendingByRun(r.runId)).toBeUndefined(); // q1 已答，无 pending
      const ask2 = await askUser(port, token, r.runId); // 再 ask → 建 q2（幂等不挡）
      expect((await ask2.json() as any).status).toBe("asked");
      expect(store.listQuestions("c-hitl", { includeAnswered: true })).toHaveLength(2);
    } finally { stop(); _clearNonces(); }
  });
});

describe("GET /conversations/:id/hitl · 刷新恢复（#16）", () => {
  test("返回 pending + answered（按 id 排）", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.createQuestion({ conversationId: "c1", runId: "r1", prompt: "q1", options: ["A"] });
    store.createQuestion({ conversationId: "c1", runId: "r2", prompt: "q2", options: ["B"] });
    store.markPendingAnsweredByRun("r2", { decision: "B" });
    const app = createApp(fullDeps(store));
    const resp = await app.request("/conversations/c1/hitl");
    expect(resp.status).toBe(200);
    const list: any = await resp.json();
    expect(list).toHaveLength(2);
    expect(list.map((q: any) => q.runId)).toEqual(["r1", "r2"]);
    expect(list[0].status).toBe("pending");
    expect(list[1].status).toBe("answered");
    expect(list[1].answer).toEqual({ decision: "B" });
  });

  test("会话不存在 → 404", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    const app = createApp(fullDeps(store));
    expect((await app.request("/conversations/nope/hitl")).status).toBe(404);
  });
});

describe("POST /conversations/:id/abort（#19）", () => {
  test("停该会话 running run → {aborted:false, stopped:N}；run 置 failed", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.createRun({ runId: "r-run", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} }); // running，无句柄
    const eventBus = new EventBus();
    const registry = new RunRegistry({ store, eventBus, runPiFactory: stubFactory });
    const app = createApp(fullDeps(store, { runRegistry: registry, eventBus }));
    const resp = await app.request("/conversations/c1/abort", { method: "POST" });
    expect(resp.status).toBe(200);
    const data: any = await resp.json();
    expect(data.aborted).toBe(false); // 无 turn 在跑
    expect(data.stopped).toBe(1); // 停了 1 个 run
    expect(store.getRun("r-run")!.status).toBe("failed");
  });

  test("会话不存在 → 404", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    const app = createApp(fullDeps(store));
    expect((await app.request("/conversations/nope/abort", { method: "POST" })).status).toBe(404);
  });
});
