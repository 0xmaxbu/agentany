// #48/T6（ADR-0025 决策 9）：TurnTrigger 整类退役——user→turn 由 POST /messages **内联**（谁消费输入谁起轮），
// run_* 事件不再驱动任何 turn（零 LLM 直投替代）；每轮注入（[待处理提问]/[挂起工作流]/[项目背景]/[工作流目录]）
// 仍由 runTurn/compose 承担——本文件经内联通路（queues.enqueueHttpTurn → runTurn）直接驱动验证。
import { describe, test, expect } from "bun:test";
import { ConversationQueues } from "../src/chat/queue";
import { EventBus } from "../src/chat/eventbus";
import { WorkflowStore } from "../src/workflow-engine/store";
import { openDbMigrated } from "../src/db/client";
import { runTurn } from "../src/chat/turn";
import type { ConfiguredRunPiStream } from "../src/pi/runPi-factory";
import type { RunDeps } from "../src/runs";
import { fullDeps } from "./deps";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(10); }
};

// 内联通路：等价于 POST /messages 的 enqueueHttpTurn→runTurn（route 同步段的核心）。
const triggerTurn = (deps: RunDeps, queues: ConversationQueues, eventBus: EventBus, convId: string, content = "hi") => {
  queues.enqueueHttpTurn(convId, (signal) => runTurn(deps, convId, content, (f) => eventBus.publish(convId, f), signal));
};

const stubStream = (): ConfiguredRunPiStream => async (call) => {
  call.onBlock?.({ op: "start", blockId: "b1", kind: "text" });
  call.onBlock?.({ op: "delta", blockId: "b1", delta: "PONG" });
  call.onBlock?.({ op: "end", blockId: "b1" });
  return { text: "PONG", messages: [], toolResults: [] };
};
const newStore = () => {
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u", title: "t" }); // #命名：已有 title → 不触发自动命名
  return store;
};

describe("user→turn 内联（#48/T6）：帧不驱动，route/队列直驱", () => {
  test("Post 之外 publish(user_message) 帧不再驱动 turn（TurnTrigger 退役）", async () => {
    const store = newStore();
    let turns = 0;
    const deps = fullDeps(store, { runPiStreamFactory: (): ConfiguredRunPiStream => async () => { turns++; return { text: "", messages: [], toolResults: [] }; } });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    eventBus.publish("c1", { type: "user_message", id: 1, content: "hi" }); // 帧 → 不应该再起 turn
    await delay(30);
    expect(turns).toBe(0);
    expect(queues.abort("c1")).toBe(false); // 无 turn 在跑
  });

  test("内联 triggerTurn → turn 起 → delta/done 经 EventBus 回", async () => {
    const store = newStore();
    const deps = fullDeps(store, { runPiStreamFactory: stubStream });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    triggerTurn(deps, queues, eventBus, "c1");
    await delayUntil(() => frames.some((f) => f.type === "done"));
    expect(frames.some((f: any) => f.type === "block_delta" && f.delta === "PONG")).toBeTrue();
    expect(frames.some((f) => f.type === "done")).toBeTrue();
  });
});

describe("run_* 不再驱动事件 turn（ADR-0025 决策 2/6/9；零 LLM 直投已替代）", () => {
  test("run_started/step_*/run_completed/suspended/failed 帧 → 零 turn", async () => {
    const store = newStore();
    let turns = 0;
    const deps = fullDeps(store, { runPiStreamFactory: (): ConfiguredRunPiStream => async () => { turns++; return { text: "", messages: [], toolResults: [] }; } });
    const eventBus = new EventBus();
    eventBus.publish("c1", { type: "run_started", runId: "r1", workflowId: "wf-x" });
    eventBus.publish("c1", { type: "step_completed", runId: "r1", stepId: "s1", status: "completed" });
    eventBus.publish("c1", { type: "run_completed", runId: "r1" });
    eventBus.publish("c1", { type: "run_suspended", runId: "r2", stepId: "review", payload: {} });
    eventBus.publish("c1", { type: "run_failed", runId: "r3", note: "boom" });
    await delay(30);
    expect(turns).toBe(0); // 事件不再起 LLM 轮（完成通知 0 LLM）
  });
});

describe("#16/#17 每轮注入（经内联 turn 通路，runTurn/compose 承担）", () => {
  test("store 有 pending question → turn appendSystemPrompt 含 [待处理提问] + runId + prompt", async () => {
    const store = newStore();
    store.createQuestion({ conversationId: "c1", runId: "r-pending", prompt: "选角度？", options: ["A", "B"], resumeSchema: { _t: "enum", vals: ["A", "B"] } });
    let capturedAppend: string[] | undefined;
    const deps = fullDeps(store, { runPiStreamFactory: (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt; await stubStream()(call); return { text: "x", messages: [], toolResults: [] };
    } });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    triggerTurn(deps, queues, eventBus, "c1");
    await delayUntil(() => frames.some((f) => f.type === "done"));
    const joined = capturedAppend!.join(" ");
    expect(joined).toContain("[待处理提问]");
    expect(joined).toContain("r-pending");
    expect(joined).toContain("选角度？");
    expect(joined).toContain("resume_workflow"); // 判答指令
  });

  test("自主卡（runId null）注入引导续答而非 resume——无 run 可续，不教 resume_workflow", async () => {
    const store = newStore();
    store.createQuestion({ conversationId: "c1", runId: null, prompt: "澄清：目标预算区间？", options: ["<10w", ">50w"] });
    let capturedAppend: string[] | undefined;
    const deps = fullDeps(store, { runPiStreamFactory: (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt; await stubStream()(call); return { text: "x", messages: [], toolResults: [] };
    } });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    eventBus.subscribe("c1", () => {});
    triggerTurn(deps, queues, eventBus, "c1");
    await delayUntil(() => capturedAppend !== undefined);
    // 自主卡注入独立分支：给问题上下文（pi 才知道用户在答什么），但不引导 resume（runId 空、调了必 400）
    const el = capturedAppend!.find((s) => s.startsWith("[待处理提问]") && !s.startsWith("[待处理提问] 工作流"));
    expect(el).toBeDefined();
    expect(el!).toContain("澄清：目标预算区间？");
    expect(el!).not.toContain('resume_workflow("'); // 不教调用（「无需调用」说明语允许出现词面）
    // run 绑定注入元素不受影响（前缀可区分——e2e stub 同款过滤）
    expect(capturedAppend!.filter((s) => s.startsWith("[待处理提问] 工作流"))).toHaveLength(0);
  });

  test("无 pending question → appendSystemPrompt 不含 [待处理提问] 元素", async () => {
    const store = newStore();
    let capturedAppend: string[] | undefined;
    const deps = fullDeps(store, { runPiStreamFactory: (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt; await stubStream()(call); return { text: "x", messages: [], toolResults: [] };
    } });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    eventBus.subscribe("c1", () => {});
    triggerTurn(deps, queues, eventBus, "c1");
    await delayUntil(() => capturedAppend !== undefined);
    // #17：每轮固定加 [项目背景]/[工作流目录] 段；改断言「无 pending ask 注入元素」
    // （CHAT_SYSTEM_PROMPT 含 [待处理提问] 指引文本，故用元素前缀过滤，非 not.toContain）。
    expect(capturedAppend!.filter((s) => s.startsWith("[待处理提问] 工作流"))).toHaveLength(0);
  });

  test("#18：approval 卡（kind=approval）不注入 pi——只 kind=ask 注入", async () => {
    const store = newStore();
    store.createQuestion({ conversationId: "c1", runId: "r-ask", prompt: "选角度？", options: ["A", "B"] }); // ask 卡（应注入）
    store.createQuestion({ conversationId: "c1", runId: null, kind: "approval", workflowId: "brand-research", input: {}, prompt: "需审批", options: ["批准", "拒绝"] }); // approval 卡（不应注入）
    let capturedAppend: string[] | undefined;
    const deps = fullDeps(store, { runPiStreamFactory: (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt; await stubStream()(call); return { text: "x", messages: [], toolResults: [] };
    } });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    eventBus.subscribe("c1", () => {});
    triggerTurn(deps, queues, eventBus, "c1");
    await delayUntil(() => capturedAppend !== undefined);
    expect(capturedAppend!.filter((s) => s.startsWith("[待处理提问] 工作流"))).toHaveLength(1); // 仅 ask 卡
    const joined = capturedAppend!.join(" ");
    expect(joined).toContain("r-ask");
    expect(joined).not.toContain("需审批");
  });

  test("挂起 run → 下一轮 appendSystemPrompt 含 [挂起工作流] + runId/stepId", async () => {
    const store = newStore();
    store.createRun({ runId: "r-susp", workflowId: "wf-x", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.updateRunStatus("r-susp", "suspended");
    store.appendLog("r-susp", { stepId: "review", status: "suspended", suspendPayload: { options: ["A"] }, resumeSchema: { _t: "enum" } });
    let capturedAppend: string[] | undefined;
    const deps = fullDeps(store, { runPiStreamFactory: (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt; await stubStream()(call); return { text: "x", messages: [], toolResults: [] };
    } });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    eventBus.subscribe("c1", () => {});
    triggerTurn(deps, queues, eventBus, "c1");
    await delayUntil(() => capturedAppend !== undefined);
    expect(capturedAppend!.some((s) => s.startsWith("[挂起工作流]"))).toBe(true);
    expect(capturedAppend!.join(" ")).toContain("r-susp");
    expect(capturedAppend!.join(" ")).toContain("review");
  });

  test("工作流目录段含已注册工作流（synthetic-3step / brand-research）", async () => {
    const store = newStore();
    let capturedAppend: string[] | undefined;
    const deps = fullDeps(store, { runPiStreamFactory: (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt; await stubStream()(call); return { text: "x", messages: [], toolResults: [] };
    } });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    eventBus.subscribe("c1", () => {});
    triggerTurn(deps, queues, eventBus, "c1");
    await delayUntil(() => capturedAppend !== undefined);
    const joined = capturedAppend!.join(" ");
    expect(capturedAppend!.some((s) => s.startsWith("[工作流目录]"))).toBe(true);
    expect(joined).toContain("synthetic-3step");
    expect(joined).toContain("brand-research");
  });

  test("项目背景段（PROJECT.md）每轮注入——首 turn 缺则建模板", async () => {
    const store = newStore();
    let capturedAppend: string[] | undefined;
    const deps = fullDeps(store, { runPiStreamFactory: (): ConfiguredRunPiStream => async (call) => {
      capturedAppend = (call as any).appendSystemPrompt; await stubStream()(call); return { text: "x", messages: [], toolResults: [] };
    } });
    const queues = new ConversationQueues();
    const eventBus = new EventBus();
    eventBus.subscribe("c1", () => {});
    triggerTurn(deps, queues, eventBus, "c1");
    await delayUntil(() => capturedAppend !== undefined);
    expect(capturedAppend!.some((s) => s.startsWith("[项目背景]"))).toBe(true);
    expect(capturedAppend!.find((s) => s.startsWith("[项目背景]"))).toContain("项目背景");
  });
});