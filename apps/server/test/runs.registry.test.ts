// ticket #14：RunRegistry（start/read/resume/abort/sweepCrashed）+ 进度事件（step_*/run_*）经 EventBus。
// 用注册的 synthetic-3step（纯程序步，无需真 pi）+ stub runPi factory。
import { describe, test, expect } from "bun:test";
import { RunRegistry } from "../src/runs/registry";
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
  const registry = new RunRegistry({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });
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

describe("T4 #44 resume 拆分（ADR-0025 决策 11）：同步 verdict + detached 续跑", () => {
  test("clean → 即时返 {running}（不阻塞）；续跑 detached 后 run_resumed/completed", async () => {
    const { eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c-test", (f) => frames.push(f));
    const r = startSynthetic(registry);
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
    const r = startSynthetic(registry);
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
    const r = startSynthetic(registry);
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
    const r = startSynthetic(registry);
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

describe("RunRegistry · stopConversationRuns（#19 abort）", () => {
  test("无句柄 stale run → 直接置 failed + 发一次 run_failed（去重）；跨会话不动", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.chat.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u" });
    store.runs.createRun({ runId: "r-stale", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} }); // running，无句柄
    store.runs.createRun({ runId: "r-c2", workflowId: "wf", workspaceId: "ws_company", conversationId: "c2", input: {} }); // 跨会话
    const eventBus = new EventBus();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const registry = new RunRegistry({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });

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
    const registry = new RunRegistry({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });
    expect(registry.stopConversationRuns("c1")).toBe(0);
    expect(frames.filter((f) => f.type === "run_failed")).toHaveLength(0);
  });
});
