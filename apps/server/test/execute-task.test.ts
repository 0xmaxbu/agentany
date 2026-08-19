// executeTask 真链测试（#29/M4-3a）：直构 seam——真 executeTask + 注入 stub runPiStreamFactory。
// 断言外部行为：产出会话落了什么消息 / task_runs 收成什么 / extension 集内容。
import { describe, test, expect } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import type { RunDeps } from "../src/runs";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { makeExecuteTask } from "../src/scheduled-tasks/execute";

interface StubCall { prompt: string; extensions?: string[]; appendSystemPrompt?: string[] }

/** scriptable runPiStream stub：按调用序回放结果；记录 prompt/extensions 供断言。 */
function stubStreamFactory(results: Array<{ text?: string; error?: Error }>) {
  const calls: StubCall[] = [];
  const factory = (opts: { extensions?: string[] }) => {
    return async (call: any) => {
      calls.push({ prompt: call.prompt, extensions: opts.extensions, appendSystemPrompt: call.appendSystemPrompt });
      const r = results[Math.min(calls.length - 1, results.length - 1)];
      if (r?.error) throw r.error;
      return { text: r?.text ?? "产出内容", messages: [], toolResults: [] };
    };
  };
  return { factory, calls };
}

function mkDeps(factory: ReturnType<typeof stubStreamFactory>["factory"]) {
  const db = openDbMigrated(":memory:");
  const store = createStores(db);
  const deps: RunDeps = {
    runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback,
    userStore: new UserStore(db),
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store.chat),
    eventBus: new EventBus(),
    runPiStreamFactory: factory as any,
  };
  return deps;
}

/** 建一个带产出会话的任务（走 createWorkspaceTask 事务）。 */
function mkTask(deps: RunDeps) {
  return deps.taskStore!.createWorkspaceTask({
    displayName: "新闻汇总", cron: "0 */4 * * *", prompt: "去网站读新闻发摘要",
    workspaceId: "ws_company", creatorId: "u_test", firstFireAt: new Date(Date.now() + 3600_000).toISOString(),
  });
}

describe("makeExecuteTask（#29 真执行链）", () => {
  test("到点执行：任务 prompt 投产出会话 → turn 跑 → 产出消息落库 → task_runs 收 ok + outputMessageId", async () => {
    const stub = stubStreamFactory([{ text: "这是摘要产出" }]);
    const deps = mkDeps(stub.factory);
    const task = mkTask(deps);
    const queues = new ConversationQueues();
    const eventBus = deps.eventBus!;
    const frames: any[] = [];
    eventBus.subscribe(task.outputConversationId!, (f) => frames.push(f));
    const executeTask = makeExecuteTask({ deps, queues, eventBus });

    await executeTask(task, "cron");
    await new Promise((r) => setTimeout(r, 20)); // 等 FIFO turn + finishRun

    // prompt 进了 pi（带任务目标）
    expect(stub.calls.map((c) => c.prompt)).toContain("去网站读新闻发摘要");
    // user 消息（任务 prompt）+ assistant 产出 都落在产出会话
    const msgs = deps.chatStore.listMessages(task.outputConversationId!);
    expect(msgs.some((m) => m.role === "user" && m.content.includes("去网站读新闻发摘要"))).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "这是摘要产出")).toBe(true);
    // task_runs：ok + outputMessageId 指向 assistant 消息
    const runs = deps.taskStore!.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].outputMessageId).not.toBeNull();
    const outMsg = msgs.find((m) => String(m.id) === String(runs[0].outputMessageId));
    expect(outMsg?.role).toBe("assistant");
    // SSE 帧（同构免费）：user_message + block 三帧 + done
    expect(frames.some((f) => f.type === "user_message")).toBe(true);
    expect(frames.some((f) => f.type === "done")).toBe(true);
  });

  test("任务 pi 无 bridge：extension 集不含 chat-bridge（仅 tavily）、appendSystemPrompt 不含 chat 工具清单", async () => {
    const stub = stubStreamFactory([{ text: "ok" }]);
    const deps = mkDeps(stub.factory);
    const task = mkTask(deps);
    const executeTask = makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! });
    await executeTask(task, "cron");
    await new Promise((r) => setTimeout(r, 20));
    expect(stub.calls.length).toBeGreaterThan(0);
    const exts = stub.calls[0].extensions ?? [];
    expect(exts.some((e) => e.includes("chat-bridge"))).toBe(false); // 不能 start_workflow/ask_user
    expect(exts.some((e) => e.includes("web-search"))).toBe(true); // tavily 保留
  });

  test("pi 抛错 → task_runs 收 failed、产出会话有可读错误说明", async () => {
    const stub = stubStreamFactory([{ error: new Error("pi crashed") }]);
    const deps = mkDeps(stub.factory);
    const task = mkTask(deps);
    const executeTask = makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! });
    // executeTask 本身不抛（scheduler.run 尾部收 failed）——错误转为产出会话说明
    await executeTask(task, "cron");
    await new Promise((r) => setTimeout(r, 20));
    const runs = deps.taskStore!.listRuns(task.id);
    expect(runs[0].status).toBe("failed");
    const msgs = deps.chatStore.listMessages(task.outputConversationId!);
    expect(msgs.some((m) => m.role === "assistant" && m.content.includes("pi crashed"))).toBe(true);
  });

  test("产出会话不存在（悬空引用）→ failed + 不抛", async () => {
    const stub = stubStreamFactory([{ text: "x" }]);
    const deps = mkDeps(stub.factory);
    // 直接 createTask（不走事务）→ outputConversationId 指向不存在的会话
    const task = deps.taskStore!.createTask({
      scope: "workspace", workspaceId: "ws_company", displayName: "悬空", cron: "0 */4 * * *",
      prompt: "p", outputConversationId: "c_ghost", creatorId: "u_test",
      nextFireAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const executeTask = makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! });
    await executeTask(task, "cron");
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.taskStore!.listRuns(task.id)[0].status).toBe("failed");
  });

  test("manual 同路径：trigger 透传、run 行 trigger=manual", async () => {
    const stub = stubStreamFactory([{ text: "手动产出" }]);
    const deps = mkDeps(stub.factory);
    const task = mkTask(deps);
    const executeTask = makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! });
    await executeTask(task, "manual");
    await new Promise((r) => setTimeout(r, 20));
    const runs = deps.taskStore!.listRuns(task.id);
    expect(runs[0].trigger).toBe("manual");
    expect(runs[0].status).toBe("ok");
  });

  test("与 TaskScheduler 集成：到点 tick → 真链跑通（markFired 先行）", async () => {
    const stub = stubStreamFactory([{ text: "第1次" }, { text: "第2次" }]);
    const deps = mkDeps(stub.factory);
    const conv = deps.chatStore.createConversation({ id: "c_exec", workspaceId: "ws_company", userId: "u", title: "T2" });
    const t2 = deps.taskStore!.createTask({
      scope: "workspace", workspaceId: "ws_company", displayName: "T2", cron: "0 * * * *",
      prompt: "p2", outputConversationId: conv.id, creatorId: "u",
      nextFireAt: new Date(Date.now() - 5000).toISOString(), // 已到期
    });
    const { TaskScheduler } = await import("../src/scheduled-tasks/scheduler");
    const queues = new ConversationQueues();
    const sched = new TaskScheduler({ store: deps.taskStore!, executeTask: makeExecuteTask({ deps, queues, eventBus: deps.eventBus! }) });
    await sched.tick();
    await new Promise((r) => setTimeout(r, 30));
    const runs = deps.taskStore!.listRuns(t2.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ok");
    expect(deps.chatStore.listMessages(conv.id).some((m) => m.content === "第1次")).toBe(true);
    expect(new Date(deps.taskStore!.getTask(t2.id)!.nextFireAt).getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});
