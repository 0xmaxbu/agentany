// ticket #13 规格：EventBus 扇出到 TurnTrigger——user_message 帧驱动 turn（非 POST 直接调 onUserMessage）。
// 本文件验「订阅驱动」拓扑：publish(user_message) → TurnTrigger 起 turn → delta/done 经 EventBus 回。
import { describe, test, expect } from "bun:test";
import { TurnTrigger } from "../src/chat/turn-trigger";
import { ConversationQueues } from "../src/chat/queue";
import { EventBus } from "../src/chat/eventbus";
import { WorkflowStore } from "../src/workflow-engine/store";
import { openDbMigrated } from "../src/db/client";
import type { ConfiguredRunPiStream } from "../src/pi/runPi-factory";
import { fullDeps } from "./deps";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(10); }
};

describe("TurnTrigger · EventBus 扇出驱动 turn（#13）", () => {
  test("attach 后 publish(user_message) → turn 起 → delta/done 经 EventBus 回（订阅驱动）", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", projectId: null, userId: "u" });
    const stubStream = (): ConfiguredRunPiStream => async (call) => {
      call.onDelta("PONG");
      return { text: "PONG", messages: [], toolResults: [] };
    };
    const deps = fullDeps(store, { runPiStreamFactory: stubStream });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    const tt = new TurnTrigger({ deps, queues, eventBus });

    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f)); // 模拟持久流（先连，否则帧丢）
    tt.attach("c1"); // TurnTrigger 订阅 EventBus（#13 扇出的那条腿）

    eventBus.publish("c1", { type: "user_message", id: 1, content: "hi" }); // 投帧 → 应驱动 turn
    await delayUntil(() => frames.some((f) => f.type === "done"));

    expect(frames.some((f) => f.type === "delta" && f.text === "PONG")).toBe(true);
    expect(frames.some((f) => f.type === "done")).toBe(true);
  });

  test("未 attach 的会话 → publish(user_message) 不起 turn", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    const deps = fullDeps(store, {
      runPiStreamFactory: (): ConfiguredRunPiStream => async () => ({ text: "", messages: [], toolResults: [] }),
    });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    new TurnTrigger({ deps, queues, eventBus }); // 不 attach
    eventBus.publish("c-other", { type: "user_message", id: 1, content: "hi" });
    await delay(30);
    expect(queues.abort("c-other")).toBe(false); // 无 turn 起来（无 active）
  });

  test("attach 幂等（重复 attach 不重复订阅→不重复起 turn）", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", projectId: null, userId: "u" });
    let turns = 0;
    const stubStream = (): ConfiguredRunPiStream => async () => { turns++; return { text: "x", messages: [], toolResults: [] }; };
    const deps = fullDeps(store, { runPiStreamFactory: stubStream });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    const tt = new TurnTrigger({ deps, queues, eventBus });
    eventBus.subscribe("c1", () => {});
    tt.attach("c1");
    tt.attach("c1"); // 重复
    eventBus.publish("c1", { type: "user_message", id: 1, content: "hi" });
    await delayUntil(() => turns >= 1);
    await delay(20);
    expect(turns).toBe(1); // 只起一个 turn
  });
});

describe("TurnTrigger · run_* 边界事件驱动自动 turn（#15）", () => {
  function setup(run?: { runId: string; log?: { stepId: string; status: string }[] }) {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", projectId: null, userId: "u" });
    if (run) {
      store.createRun({ runId: run.runId, workflowId: "wf-x", projectId: null, conversationId: "c1", input: {} });
      for (const e of run.log ?? []) store.appendLog(run.runId, { stepId: e.stepId, status: e.status as any, input: {}, output: {} });
    }
    let turnCount = 0, lastPrompt = "", lastAppend: string[] | undefined;
    const factory = (): ConfiguredRunPiStream => async (call) => {
      turnCount++; lastPrompt = call.prompt; lastAppend = (call as any).appendSystemPrompt;
      call.onDelta("OK");
      return { text: "OK", messages: [], toolResults: [] };
    };
    const deps = fullDeps(store, { runPiStreamFactory: factory });
    const eventBus = new EventBus();
    const tt = new TurnTrigger({ deps, queues: new ConversationQueues(), eventBus });
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    tt.attach("c1");
    return { eventBus, frames, counts: () => turnCount, prompt: () => lastPrompt, append: () => lastAppend };
  }

  test("run_completed → 自动事件 turn（prompt 含「已完成」+workflowId+日志摘要）；run_started/step_* 不触发", async () => {
    const { eventBus, frames, counts, prompt, append } = setup({ runId: "r1", log: [{ stepId: "s1", status: "completed" }] });
    eventBus.publish("c1", { type: "run_started", runId: "r1", workflowId: "wf-x" });
    eventBus.publish("c1", { type: "step_started", runId: "r1", stepId: "s1" });
    eventBus.publish("c1", { type: "step_completed", runId: "r1", stepId: "s1", status: "completed" });
    eventBus.publish("c1", { type: "run_completed", runId: "r1" });
    await delayUntil(() => frames.some((f) => f.type === "done"));
    await delay(30);
    expect(counts()).toBe(1); // 只 run_completed 触发；run_started/step_* 不触发 turn
    expect(prompt()).toContain("已完成");
    expect(prompt()).toContain("wf-x");
    expect(prompt()).toContain("s1"); // 日志摘要（store.getLog 拼）
    expect(append()).toBeDefined(); // --append-system-prompt 通路（基础 chat system）
    expect(append()!.join(" ")).toMatch(/对话助手|chat/);
  });

  test("run_suspended → 自动事件 turn（prompt 含「挂起」+payload；不提 resume_workflow/ask_user）", async () => {
    const { eventBus, frames, prompt } = setup();
    eventBus.publish("c1", { type: "run_started", runId: "r2", workflowId: "wf-y" });
    eventBus.publish("c1", { type: "run_suspended", runId: "r2", stepId: "review", payload: { options: ["A", "B"] }, resumeSchema: { type: "object" } });
    await delayUntil(() => frames.some((f) => f.type === "done"));
    expect(prompt()).toContain("挂起");
    expect(prompt()).toContain("review");
    expect(prompt()).toContain("options"); // payload 进 prompt
    expect(prompt()).not.toContain("resume_workflow"); // #16 才加，#15 不提
    expect(prompt()).not.toContain("ask_user");
  });

  test("run_failed → 自动事件 turn（prompt 含「失败」+note）", async () => {
    const { eventBus, frames, prompt } = setup();
    eventBus.publish("c1", { type: "run_started", runId: "r3", workflowId: "wf-z" });
    eventBus.publish("c1", { type: "run_failed", runId: "r3", note: "boom crash" });
    await delayUntil(() => frames.some((f) => f.type === "done"));
    expect(prompt()).toContain("失败");
    expect(prompt()).toContain("boom crash");
  });
});

describe("TurnTrigger · pending 提问每轮注入（#16）", () => {
  test("store 有 pending question → turn appendSystemPrompt 含 [待处理提问] + runId + prompt", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", projectId: null, userId: "u" });
    store.createQuestion({ conversationId: "c1", runId: "r-pending", prompt: "选角度？", options: ["A", "B"], resumeSchema: { _t: "enum", vals: ["A", "B"] } });
    let capturedAppend: string[] | undefined;
    const factory = (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt;
      call.onDelta("x");
      return { text: "x", messages: [], toolResults: [] };
    };
    const deps = fullDeps(store, { runPiStreamFactory: factory });
    const eventBus = new EventBus();
    const tt = new TurnTrigger({ deps, queues: new ConversationQueues(), eventBus });
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    tt.attach("c1");
    eventBus.publish("c1", { type: "user_message", id: 1, content: "hi" });
    await delayUntil(() => frames.some((f) => f.type === "done"));
    expect(capturedAppend).toBeDefined();
    const joined = capturedAppend!.join(" ");
    expect(joined).toContain("[待处理提问]");
    expect(joined).toContain("r-pending");
    expect(joined).toContain("选角度？");
    expect(joined).toContain("resume_workflow"); // 判答指令
  });

  test("无 pending question → appendSystemPrompt 只含基础 chat system（无 [待处理提问]）", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", projectId: null, userId: "u" });
    let capturedAppend: string[] | undefined;
    const factory = (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt;
      call.onDelta("x");
      return { text: "x", messages: [], toolResults: [] };
    };
    const deps = fullDeps(store, { runPiStreamFactory: factory });
    const eventBus = new EventBus();
    const tt = new TurnTrigger({ deps, queues: new ConversationQueues(), eventBus });
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    tt.attach("c1");
    eventBus.publish("c1", { type: "user_message", id: 1, content: "hi" });
    await delayUntil(() => frames.some((f) => f.type === "done"));
    // #17：每轮固定加 [项目背景]/[工作流目录] 段，故不再断言总长度；改断言「无 pending ask 注入元素」
    // （CHAT_SYSTEM_PROMPT 含 [待处理提问] 指引文本，故用元素前缀过滤，非 not.toContain）。
    expect(capturedAppend!.filter((s) => s.startsWith("[待处理提问] 工作流"))).toHaveLength(0);
  });

  test("#18：approval 卡（kind=approval）不注入 pi——只 kind=ask 注入；审批走 /approvals，不污染 turn 判答", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", projectId: null, userId: "u" });
    store.createQuestion({ conversationId: "c1", runId: "r-ask", prompt: "选角度？", options: ["A", "B"] }); // ask 卡（应注入）
    store.createQuestion({ conversationId: "c1", runId: null, kind: "approval", workflowId: "brand-research", input: {}, prompt: "需审批", options: ["批准", "拒绝"] }); // approval 卡（不应注入）
    let capturedAppend: string[] | undefined;
    const factory = (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt;
      call.onDelta("x");
      return { text: "x", messages: [], toolResults: [] };
    };
    const deps = fullDeps(store, { runPiStreamFactory: factory });
    const eventBus = new EventBus();
    const tt = new TurnTrigger({ deps, queues: new ConversationQueues(), eventBus });
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    tt.attach("c1");
    eventBus.publish("c1", { type: "user_message", id: 1, content: "hi" });
    await delayUntil(() => frames.some((f) => f.type === "done"));
    // #17：每轮固定加 [项目背景]/[工作流目录] 段，总长度不再固定；改断言「仅 1 个 ask 注入元素、无 approval」。
    expect(capturedAppend!.filter((s) => s.startsWith("[待处理提问] 工作流"))).toHaveLength(1); // 仅 ask 卡
    const joined = capturedAppend!.join(" ");
    expect(joined).toContain("r-ask"); // ask 卡注入
    expect(joined).not.toContain("需审批"); // approval 卡 prompt 不注入（其 workflowId 已出现在 #17 工作流目录段，故不判 brand-research）
  });
});

describe("TurnTrigger · #17 每轮注入（项目背景 / 工作流目录 / 挂起 run）", () => {
  test("挂起 run → 下一轮 appendSystemPrompt 含 [挂起工作流] + runId/stepId", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", projectId: null, userId: "u" });
    store.createRun({ runId: "r-susp", workflowId: "wf-x", projectId: null, conversationId: "c1", input: {} });
    store.updateRunStatus("r-susp", "suspended");
    store.appendLog("r-susp", { stepId: "review", status: "suspended", suspendPayload: { options: ["A"] }, resumeSchema: { _t: "enum" } });
    let capturedAppend: string[] | undefined;
    const factory = (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt;
      call.onDelta("x");
      return { text: "x", messages: [], toolResults: [] };
    };
    const deps = fullDeps(store, { runPiStreamFactory: factory });
    const eventBus = new EventBus();
    const tt = new TurnTrigger({ deps, queues: new ConversationQueues(), eventBus });
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    tt.attach("c1");
    eventBus.publish("c1", { type: "user_message", id: 1, content: "hi" });
    await delayUntil(() => frames.some((f) => f.type === "done"));
    const joined = capturedAppend!.join(" ");
    expect(capturedAppend!.some((s) => s.startsWith("[挂起工作流]"))).toBe(true);
    expect(joined).toContain("r-susp");
    expect(joined).toContain("review");
  });

  test("工作流目录段含已注册工作流（synthetic-3step / brand-research）", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", projectId: null, userId: "u" });
    let capturedAppend: string[] | undefined;
    const factory = (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt;
      call.onDelta("x");
      return { text: "x", messages: [], toolResults: [] };
    };
    const deps = fullDeps(store, { runPiStreamFactory: factory });
    const eventBus = new EventBus();
    const tt = new TurnTrigger({ deps, queues: new ConversationQueues(), eventBus });
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    tt.attach("c1");
    eventBus.publish("c1", { type: "user_message", id: 1, content: "hi" });
    await delayUntil(() => frames.some((f) => f.type === "done"));
    const joined = capturedAppend!.join(" ");
    expect(capturedAppend!.some((s) => s.startsWith("[工作流目录]"))).toBe(true);
    expect(joined).toContain("synthetic-3step");
    expect(joined).toContain("brand-research");
  });

  test("项目背景段（PROJECT.md）每轮注入——首 turn 缺则建模板", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c-projdoc", projectId: null, userId: "u" });
    let capturedAppend: string[] | undefined;
    const factory = (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt;
      call.onDelta("x");
      return { text: "x", messages: [], toolResults: [] };
    };
    const deps = fullDeps(store, { runPiStreamFactory: factory });
    const eventBus = new EventBus();
    const tt = new TurnTrigger({ deps, queues: new ConversationQueues(), eventBus });
    const frames: any[] = [];
    eventBus.subscribe("c-projdoc", (f) => frames.push(f));
    tt.attach("c-projdoc");
    eventBus.publish("c-projdoc", { type: "user_message", id: 1, content: "hi" });
    await delayUntil(() => frames.some((f) => f.type === "done"));
    // [项目背景] 段在（首 turn 建 data/general/workspace/PROJECT.md 模板）
    expect(capturedAppend!.some((s) => s.startsWith("[项目背景]"))).toBe(true);
    expect(capturedAppend!.find((s) => s.startsWith("[项目背景]"))).toContain("项目背景");
  });
});
