// ticket #14：RunRegistry（start/read/resume/abort/sweepCrashed）+ 进度事件（step_*/run_*）经 EventBus。
// 用注册的 synthetic-3step（纯程序步，无需真 pi）+ stub runPi factory。
import { describe, test, expect } from "bun:test";
import { RunRegistry } from "../src/runs/registry";
import { EventBus } from "../src/chat/eventbus";
import { WorkflowStore } from "../src/workflow-engine/store";
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
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  const eventBus = new EventBus();
  store.createConversation({ id: "c-test", workspaceId: "ws_company", userId: "u" }); // general 会话
  const registry = new RunRegistry({ store, eventBus, runPiFactory: stubFactory });
  return { store, eventBus, registry };
}

// synthetic-3step under auto posture → allow → {running}；窄化 runId（#18 StartOutcome 联合）。
function startSynthetic(registry: RunRegistry, input: Record<string, unknown> = {}, conv = "c-test") {
  const r = registry.start({ conversationId: conv, workflowId: "synthetic-3step", input });
  if (r.status !== "running") throw new Error(`synthetic should run under auto, got ${r.status}`);
  return r;
}

describe("RunRegistry · start / read / 进度事件", () => {
  test("start → 立即返 {running, runId}；run 异步跑到 review 挂起；step_*/run_* 推 EventBus", async () => {
    const { eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c-test", (f) => frames.push(f));

    const r = startSynthetic(registry, { offset: 0 });
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

  test("read 不存在的 run → null；start 未知工作流 → 抛", () => {
    const { registry } = newRegistry();
    expect(registry.read("nope")).toBeNull();
    expect(() => registry.start({ conversationId: "c-test", workflowId: "nope", input: {} })).toThrow(/not found/);
  });
});

describe("RunRegistry · resume", () => {
  test("resume(accept) → 续跑至 completed；推 run_resumed/.../run_completed", async () => {
    const { eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c-test", (f) => frames.push(f));
    const r = startSynthetic(registry);
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));

    await registry.resume(r.runId, { decision: "accept" });
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));

    expect(frames.map((f) => f.type)).toContain("run_resumed");
    expect(frames.map((f) => f.type)).toContain("run_completed");
    expect(registry.read(r.runId)!.status).toBe("completed");
    expect(registry.read(r.runId)!.steps.map((s) => s.stepId)).toEqual(["s1", "review", "review", "s2"]);
  });
});

describe("RunRegistry · abort + sweepCrashed", () => {
  test("abort(runId) → true（句柄在）；abort(未知) → false", async () => {
    const { registry } = newRegistry();
    const r = startSynthetic(registry);
    expect(registry.abort(r.runId)).toBe(true);
    expect(registry.abort("nope")).toBe(false);
    await delay(20); // 让 detached run 沉淀
  });

  test("sweepCrashed → DB 里 running 的 run 标 failed", () => {
    const { store, registry } = newRegistry();
    store.createRun({ runId: "r-stuck", workflowId: "synthetic-3step", workspaceId: "ws_company", input: {} }); // 默认 running
    expect(store.getRun("r-stuck")!.status).toBe("running");
    const n = registry.sweepCrashed();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(store.getRun("r-stuck")!.status).toBe("failed");
  });
});

describe("store · listSuspendedRuns（#17）", () => {
  test("返该会话的挂起 run（带 stepId/payload/resumeSchema）；排除非挂起 + 跨会话", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u" });
    // c1 挂起 run
    store.createRun({ runId: "r-susp", workflowId: "wf-a", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.updateRunStatus("r-susp", "suspended");
    store.appendLog("r-susp", { stepId: "review", status: "suspended", suspendPayload: { options: ["A"] }, resumeSchema: { _t: "enum", vals: ["A"] } });
    // c1 running run（排除）
    store.createRun({ runId: "r-run", workflowId: "wf-b", workspaceId: "ws_company", conversationId: "c1", input: {} });
    // c2 挂起 run（跨会话排除）
    store.createRun({ runId: "r-other", workflowId: "wf-c", workspaceId: "ws_company", conversationId: "c2", input: {} });
    store.updateRunStatus("r-other", "suspended");
    store.appendLog("r-other", { stepId: "s", status: "suspended", suspendPayload: {}, resumeSchema: {} });

    const susp = store.listSuspendedRuns("c1");
    expect(susp).toHaveLength(1);
    expect(susp[0].runId).toBe("r-susp");
    expect(susp[0].workflowId).toBe("wf-a");
    expect(susp[0].stepId).toBe("review");
    expect(susp[0].payload).toEqual({ options: ["A"] });
    expect(susp[0].resumeSchema).toEqual({ _t: "enum", vals: ["A"] });
  });

  test("无挂起 run → []", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    expect(store.listSuspendedRuns("c1")).toEqual([]);
  });
});

describe("store · listRunningRunIds（#19 abort）", () => {
  test("返该会话的 running run；排除非 running + 跨会话", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u" });
    store.createRun({ runId: "r-run", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} }); // running
    store.createRun({ runId: "r-susp", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.updateRunStatus("r-susp", "suspended"); // 非 running
    store.createRun({ runId: "r-other", workflowId: "wf", workspaceId: "ws_company", conversationId: "c2", input: {} }); // 跨会话
    expect(store.listRunningRunIds("c1")).toEqual(["r-run"]);
  });

  test("无 running → []", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    expect(store.listRunningRunIds("c1")).toEqual([]);
  });
});

describe("RunRegistry · stopConversationRuns（#19 abort）", () => {
  test("无句柄 stale run → 直接置 failed + 发一次 run_failed（去重）；跨会话不动", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u" });
    store.createRun({ runId: "r-stale", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} }); // running，无句柄
    store.createRun({ runId: "r-c2", workflowId: "wf", workspaceId: "ws_company", conversationId: "c2", input: {} }); // 跨会话
    const eventBus = new EventBus();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const registry = new RunRegistry({ store, eventBus, runPiFactory: stubFactory });

    const n = registry.stopConversationRuns("c1");
    expect(n).toBe(1);
    expect(store.getRun("r-stale")!.status).toBe("failed");
    const failed = frames.filter((f) => f.type === "run_failed" && f.runId === "r-stale");
    expect(failed).toHaveLength(1); // 恰好一次（去重：无句柄直接发一次）
    expect(failed[0].note).toMatch(/aborted/);
    expect(store.getRun("r-c2")!.status).toBe("running"); // 跨会话不动
  });

  test("无 running → 0，不发帧", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    const eventBus = new EventBus();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const registry = new RunRegistry({ store, eventBus, runPiFactory: stubFactory });
    expect(registry.stopConversationRuns("c1")).toBe(0);
    expect(frames.filter((f) => f.type === "run_failed")).toHaveLength(0);
  });
});
