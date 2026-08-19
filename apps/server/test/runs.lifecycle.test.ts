// ticket #14：RunLifecycle（start/read/resume/abort/sweepCrashed）+ 进度事件（step_*/run_*）经 EventBus。
// 用注册的 synthetic-3step（纯程序步，无需真 pi）+ stub runPi factory。
// ADR-0031（A2 #68）：verdictOf 单一裁决源 / sync 语义 / 二次挂起 / 引擎诚实化 acceptance 追加。
import { describe, test, expect } from "bun:test";
import { RunLifecycle } from "../src/runs/lifecycle";
import { verdictOf } from "../src/workflow-engine/runner";
import { EventBus } from "../src/chat/eventbus";
import { createStores, type Stores } from "../src/stores";
import { openDbMigrated } from "../src/db/client";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < timeoutMs) {
    if (pred()) return;
    await delay(10);
  }
};

// synthetic 步不调 runPi，但 ctx 需一个 factory；stub 永不被调。
const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });

function newRegistry() {
  const store = createStores(openDbMigrated(":memory:"));
  const eventBus = new EventBus();
  store.chat.createConversation({ id: "c-test", workspaceId: "ws_company", userId: "u" }); // general 会话
  const registry = new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });
  return { store, eventBus, registry };
}

// synthetic-3step under auto posture → allow → {running}；窄化 runId（#18 StartResult 联合）。
async function startSynthetic(registry: RunLifecycle, input: Record<string, unknown> = {}, conv = "c-test") {
  const r = await registry.start({ conversationId: conv, workflowId: "synthetic-3step", input });
  if (r.status !== "running") throw new Error(`synthetic should run under auto, got ${r.status}`);
  return r;
}

describe("RunLifecycle · start / read / 进度事件", () => {
  test("start → 立即返 {running, runId}；run 异步跑到 review 挂起；step_*/run_* 推 EventBus", async () => {
    const { eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c-test", (f) => frames.push(f));

    const r = await startSynthetic(registry, { offset: 0 });
    expect(r.status).toBe("running"); // 立即返（run 不绑 turn）
    expect(r.runId).toBeTruthy();

    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));
    const types = frames.map((f) => f.type);
    expect(types).toContain("run_started");
    expect(frames.find((f) => f.type === "run_started")?.workflowId).toBe("synthetic-3step"); // 引擎 run() 发、带 workflowId
    expect(types.filter((t) => t === "step_started").length).toBeGreaterThanOrEqual(2); // s1 + review
    expect(types).toContain("step_completed");
    expect(types).toContain("run_suspended");

    const rd = registry.read(r.runId)!;
    expect(rd.status).toBe("suspended");
    expect(rd.steps.map((s) => s.stepId)).toEqual(["s1", "review"]);
    expect(rd.steps.map((s) => s.status)).toEqual(["completed", "suspended"]);
  });

  test("read 不存在的 run → null；start 未知工作流 → 抛", async () => {
    const { registry } = newRegistry();
    expect(registry.read("nope")).toBeNull();
    await expect(registry.start({ conversationId: "c-test", workflowId: "nope", input: {} })).rejects.toThrow(/not found/);
  });
});

describe("RunLifecycle · resume", () => {
  test("resume(accept) → 续跑至 completed；推 run_resumed/.../run_completed", async () => {
    const { eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c-test", (f) => frames.push(f));
    const r = await startSynthetic(registry);
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));

    await registry.resume(r.runId, { decision: "accept" });
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));

    expect(frames.map((f) => f.type)).toContain("run_resumed");
    expect(frames.map((f) => f.type)).toContain("run_completed");
    expect(registry.read(r.runId)!.status).toBe("completed");
    expect(registry.read(r.runId)!.steps.map((s) => s.stepId)).toEqual(["s1", "review", "review", "s2"]);
  });
});

describe("T4 #44 resume 拆分（ADR-0025 决策 11）：同步 verdict + detached 续跑", () => {
  test("clean → 即时返 {running}（不阻塞）；续跑 detached 后 run_resumed/completed", async () => {
    const { eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c-test", (f) => frames.push(f));
    const r = await startSynthetic(registry);
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));

    const t0 = Date.now();
    const out = await registry.resume(r.runId, { decision: "accept" });
    // 同步 verdict：即时返 running（旧实现在此 await 整个续跑至 completed）
    expect(out.status).toBe("running");
    expect(Date.now() - t0).toBeLessThan(500);
    // 续跑 detached：最终仍到 completed + run_resumed 帧
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));
    expect(frames.map((f) => f.type)).toContain("run_resumed");
    expect(registry.read(r.runId)!.status).toBe("completed");
  });

  test("rejected → 即时 {rejected}，不动状态、不发 run_* 帧", async () => {
    const { eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c-test", (f) => frames.push(f));
    const r = await startSynthetic(registry);
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));

    const t0 = Date.now();
    const out = await registry.resume(r.runId, { decision: "bogus" } as any); // schema 校验失败
    expect(out).toMatchObject({ rejected: true });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(frames.some((f) => f.type === "run_resumed" || f.type === "run_completed")).toBeFalse();
    expect(registry.read(r.runId)!.status).toBe("suspended"); // 保持挂起（供重试）
  });

  test("idempotent → 即时 {idempotent}（非挂起态不续跑、无帧）", async () => {
    const { eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c-test", (f) => frames.push(f));
    const r = await startSynthetic(registry);
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));
    await registry.resume(r.runId, { decision: "accept" });
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));

    frames.length = 0; // 清帧：第二次 resume（已 completed）必须零副作用
    const t0 = Date.now();
    const out = await registry.resume(r.runId, { decision: "accept" });
    expect(out).toMatchObject({ idempotent: true });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(frames.some((f) => f.type === "run_resumed" || f.type === "run_completed")).toBeFalse();
  });

  test("并发双击 → 两路都 running，但只续跑一次（不二次执行、单 run_resumed、步骤不翻倍）", async () => {
    const { eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c-test", (f) => frames.push(f));
    const r = await startSynthetic(registry);
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));

    const [a, b] = await Promise.all([
      registry.resume(r.runId, { decision: "accept" }),
      registry.resume(r.runId, { decision: "accept" }),
    ]);
    expect(a.status).toBe("running");
    expect(b.status).toBe("running");
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));
    expect(frames.filter((f) => f.type === "run_resumed").length).toBe(1); // 二路之二 idempotent 静默
    expect(registry.read(r.runId)!.steps).toHaveLength(4); // s1, review, review, s2 —— 未翻倍
  });
});

describe("RunLifecycle · abort + sweepCrashed", () => {
  test("abort(runId) → true（句柄在）；abort(未知) → false", async () => {
    const { registry } = newRegistry();
    const r = await startSynthetic(registry);
    expect(registry.abort(r.runId)).toBe(true);
    expect(registry.abort("nope")).toBe(false);
    await delay(20); // 让 detached run 沉淀
  });

  test("sweepCrashed → DB 里 running 的 run 标 failed", () => {
    const { store, registry } = newRegistry();
    store.runs.createRun({ runId: "r-stuck", workflowId: "synthetic-3step", workspaceId: "ws_company", input: {} }); // 默认 running
    expect(store.runs.getRun("r-stuck")!.status).toBe("running");
    const n = registry.sweepCrashed();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(store.runs.getRun("r-stuck")!.status).toBe("failed");
  });
});

describe("store · listSuspendedRuns（#17）", () => {
  test("返该会话的挂起 run（带 stepId/payload/resumeSchema）；排除非挂起 + 跨会话", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.chat.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u" });
    // c1 挂起 run
    store.runs.createRun({ runId: "r-susp", workflowId: "wf-a", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.runs.updateRunStatus("r-susp", "suspended");
    store.runs.appendLog("r-susp", { stepId: "review", status: "suspended", suspendPayload: { options: ["A"] }, resumeSchema: { _t: "enum", vals: ["A"] } });
    // c1 running run（排除）
    store.runs.createRun({ runId: "r-run", workflowId: "wf-b", workspaceId: "ws_company", conversationId: "c1", input: {} });
    // c2 挂起 run（跨会话排除）
    store.runs.createRun({ runId: "r-other", workflowId: "wf-c", workspaceId: "ws_company", conversationId: "c2", input: {} });
    store.runs.updateRunStatus("r-other", "suspended");
    store.runs.appendLog("r-other", { stepId: "s", status: "suspended", suspendPayload: {}, resumeSchema: {} });

    const susp = store.runs.listSuspendedRuns("c1");
    expect(susp).toHaveLength(1);
    expect(susp[0].runId).toBe("r-susp");
    expect(susp[0].workflowId).toBe("wf-a");
    expect(susp[0].stepId).toBe("review");
    expect(susp[0].payload).toEqual({ options: ["A"] });
    expect(susp[0].resumeSchema).toEqual({ _t: "enum", vals: ["A"] });
  });

  test("无挂起 run → []", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    expect(store.runs.listSuspendedRuns("c1")).toEqual([]);
  });
});

describe("store · listRunningRunIds（#19 abort）", () => {
  test("返该会话的 running run；排除非 running + 跨会话", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.chat.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u" });
    store.runs.createRun({ runId: "r-run", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} }); // running
    store.runs.createRun({ runId: "r-susp", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.runs.updateRunStatus("r-susp", "suspended"); // 非 running
    store.runs.createRun({ runId: "r-other", workflowId: "wf", workspaceId: "ws_company", conversationId: "c2", input: {} }); // 跨会话
    expect(store.runs.listRunningRunIds("c1")).toEqual(["r-run"]);
  });

  test("无 running → []", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    expect(store.runs.listRunningRunIds("c1")).toEqual([]);
  });
});

describe("RunLifecycle · stopConversationRuns（#19 abort）", () => {
  test("无句柄 stale run → 直接置 failed + 发一次 run_failed（去重）；跨会话不动", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.chat.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u" });
    store.runs.createRun({ runId: "r-stale", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} }); // running，无句柄
    store.runs.createRun({ runId: "r-c2", workflowId: "wf", workspaceId: "ws_company", conversationId: "c2", input: {} }); // 跨会话
    const eventBus = new EventBus();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const registry = new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });

    const n = registry.stopConversationRuns("c1");
    expect(n).toBe(1);
    expect(store.runs.getRun("r-stale")!.status).toBe("failed");
    const failed = frames.filter((f) => f.type === "run_failed" && f.runId === "r-stale");
    expect(failed).toHaveLength(1); // 恰好一次（去重：无句柄直接发一次）
    expect(failed[0].note).toMatch(/aborted/);
    expect(store.runs.getRun("r-c2")!.status).toBe("running"); // 跨会话不动
  });

  test("无 running → 0，不发帧", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    const eventBus = new EventBus();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const registry = new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });
    expect(registry.stopConversationRuns("c1")).toBe(0);
    expect(frames.filter((f) => f.type === "run_failed")).toHaveLength(0);
  });
});

// ── ADR-0031 acceptance（A2 #68）：verdictOf 单源 / 双机同源 / sync / 二次挂起卡 / 引擎诚实 ──
describe("ADR-0031 · verdictOf 单一裁决源（决策 3）", () => {
  test("verdictOf 直接：挂起+合法 → running；挂起+非法 → rejected；非挂起 → idempotent", async () => {
    const { store, registry } = newRegistry();
    const r = await startSynthetic(registry);
    await delayUntil(() => registry.read(r.runId)!.status === "suspended");
    // 合法 resumeData
    expect(verdictOf(store.runs, r.runId, { decision: "accept" }).kind).toBe("running");
    // 非法（缺必填 decision）
    expect(verdictOf(store.runs, r.runId, { bogus: 1 }).kind).toBe("rejected");
    // 非挂起 run（completed → idempotent）
    store.runs.createRun({ runId: "r-done", workflowId: "synthetic-3step", workspaceId: "ws_company", input: {} });
    store.runs.setTerminalBrief({ runId: "r-done", status: "completed", brief: "b", messageContent: "", conversationId: null });
    expect(verdictOf(store.runs, "r-done", { decision: "accept" }).kind).toBe("idempotent");
  });

  test("双机同源：lifecycle.resume 同步预检与引擎 resumeInner 同一 verdict（非法一判，二处同错）", async () => {
    const { store, registry } = newRegistry();
    const r = await startSynthetic(registry);
    await delayUntil(() => registry.read(r.runId)!.status === "suspended");
    const verdict = verdictOf(store.runs, r.runId, { bogus: 1 });
    expect(verdict.kind).toBe("rejected");
    const out = await registry.resume(r.runId, { bogus: 1 });
    // lifecycle.resume 同步段立刻还 rejected（同 error，无需等 detached 续跑）
    expect("rejected" in out && out.rejected).toBe(true);
    expect("error" in out && (out as any).error).toBe((verdict as any).error);
    expect(store.runs.getRun(r.runId)!.status).toBe("suspended"); // 状态不动（供重试）
  });

  test("resume(clean) → 同步 {running}；verdictOf 同参亦 running（双机一致）", async () => {
    const { store, registry } = newRegistry();
    const r = await startSynthetic(registry);
    await delayUntil(() => registry.read(r.runId)!.status === "suspended");
    expect(verdictOf(store.runs, r.runId, { decision: "accept" }).kind).toBe("running");
    const out = await registry.resume(r.runId, { decision: "accept" });
    expect(out.status).toBe("running");
  });
});

describe("ADR-0031 · sync=true 直接返 RunOutcome（决策 2/6）", () => {
  test("start({sync:true}) → await 完即 RunOutcome（suspended）；不 detached；read 同步可见挂起", async () => {
    const { registry } = newRegistry();
    const out = await registry.start({ conversationId: "c-test", workflowId: "synthetic-3step", input: { offset: 0 }, sync: true });
    expect(out.status).toBe("suspended"); // 真结局（不返 {running}）
    if (out.status !== "suspended") throw new Error("expected suspended");
    expect(out.stepId).toBe("review");
    expect(registry.read(out.runId)!.status).toBe("suspended"); // 同步已收口（无 detached 竞态）
  });
});

describe("ADR-0031 · 二次挂起带 resumeSchema（G1 卡列传）", () => {
  test("redirect 续跑 → 再挂起：新卡带 resumeSchema + run_suspended 再发", async () => {
    const { store, eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c-test", (f) => frames.push(f));
    const r = await startSynthetic(registry, { offset: 0 });
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));
    // 第一张卡
    expect(store.hitl.listQuestions("c-test")).toHaveLength(1);
    const firstCard = store.hitl.listQuestions("c-test")[0];
    expect((firstCard.resumeSchema as any)?.shape?.decision).toBeTruthy();

    // redirect → s1 重跑 → review 再挂起（新卡，同一 run）
    const out = await registry.resume(r.runId, { decision: "redirect" });
    expect(out.status).toBe("running"); // 同步 verdict
    await delayUntil(() => frames.filter((f) => f.type === "run_suspended").length >= 2);
    const qs = store.hitl.listQuestions("c-test");
    expect(qs).toHaveLength(2); // 两张卡（首挂 + 二次挂）；旧卡保持 pending（同一 resumeSchema 契约）
    expect(qs[1].resumeSchema).toEqual(qs[0].resumeSchema); // resumeSchema 复刻进二卡
    expect(qs[1].runId).toBe(r.runId);
    // redired 消费点 review 的 completed 步带 resumeData（答案入 log）；二次挂起是新一轮问句（空——G1「首挂无答案」对称）
    const logs = store.runs.getLog(r.runId);
    expect(logs[logs.length - 1].status).toBe("suspended"); // 二次挂起
    const consumed = logs.filter((e) => e.stepId === "review" && e.status === "completed");
    expect(consumed).toHaveLength(1); // 仅 redirect 消费那一次（二次挂起还没被答）
    expect(consumed[0].resumeData).toEqual({ decision: "redirect" }); // 答案在消费步
  });
});

describe("ADR-0031 · 引擎诚实化（决策 4）", () => {
  test("顶层 catch-all：runPiFactory 抛错被引擎捕获 → failed outcome（不越状态机抛出）", async () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c-test", workspaceId: "ws_company", userId: "u" });
    // 走需 runPi 的已注册工作流 + 抛错 factory → sync 路径应返 failed 而非抛（引擎诚实：catch-all 吞进 failed）。
    // 选 brand-research（第一步 research 调 runPi）。approved 跳审批门。
    const boom = (): ConfiguredRunPi => async () => { throw new Error("pi exploded"); };
    const registry = new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus: new EventBus(), runPiFactory: boom });
    const out = await registry.start({ conversationId: "c-test", workflowId: "brand-research", input: { brand: "诚实车" }, approved: true, sync: true });
    if (out.status !== "failed") throw new Error(`expected failed, got ${out.status}`); // 窄化：runPi 抛错 → engine catch-all → failed
    expect(store.runs.getRun(out.runId)!.status).toBe("failed"); // 状态机也收口（不卡 running）
  });

  test("verdictOf 对无 log 的 run → idempotent（不崩）", () => {
    const { store } = newRegistry();
    const v = verdictOf(store.runs, "absent", {});
    expect(v.kind).toBe("idempotent");
  });
});
