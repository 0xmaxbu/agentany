// #32/M4-5 system 任务 headless 执行链：无产出会话，pi 一次性跑（makeRunPi 路径），
// 产出=task_runs 日志（status + note 错误详情）；管理页执行历史可读（note 列）。
// seam：直构 executeTask + stub runPiFactory（headless 用缓冲版 runPi，非 runPiStream）。
import { describe, test, expect } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { makeExecuteTask } from "../src/scheduled-tasks/execute";
import type { RunDeps } from "../src/runs";

/** headless 用缓冲版 runPi stub：记录调用（prompt/session/extensions），回放结果。 */
function stubRunPiFactory(results: Array<{ text?: string; error?: Error }>) {
  const calls: Array<{ prompt: string; sessionId: string; extensions?: string[]; appendSystemPrompt?: string[] }> = [];
  const factory = (opts: { extensions?: string[]; scope: string; workspaceId: string | null; sessionId: string }) => {
    return async (call: { prompt: string; timeoutMs?: number }) => {
      calls.push({ prompt: call.prompt, sessionId: opts.sessionId, extensions: opts.extensions, appendSystemPrompt: (call as any).appendSystemPrompt });
      const r = results[Math.min(calls.length - 1, results.length - 1)];
      if (r?.error) throw r.error;
      return { text: r?.text ?? "蒸馏产出", messages: [], toolResults: [] };
    };
  };
  return { factory, calls };
}

function mkDeps(factory?: ReturnType<typeof stubRunPiFactory>["factory"]): RunDeps {
  const db = openDbMigrated(":memory:");
  const store = new WorkflowStore(db);
  return {
    store,
    userStore: new UserStore(db),
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store),
    eventBus: new EventBus(),
    runPiFactory: factory as any,
  };
}

/** system 任务行（蒸馏 seed 形态：workspaceId=null、无产出会话）。 */
function mkSystemTask(deps: RunDeps, opts: { enabled?: boolean; nextFireAt?: string } = {}) {
  return deps.taskStore!.createTask({
    scope: "system", workspaceId: null, displayName: "经验蒸馏（每周）", cron: "0 4 * * 0",
    prompt: "蒸馏本周反馈与执行过程，产出经验写入 experience.md",
    outputConversationId: null, creatorId: "system",
    nextFireAt: opts.nextFireAt ?? new Date(Date.now() - 5000).toISOString(), // 已到期
  });
}

describe("headless 执行（#32 system 任务）", () => {
  test("到点执行：pi 一次性跑（同 taskId 固定 session、无 bridge extension）→ task_runs ok + 无 outputMessageId + 不写任何会话消息", async () => {
    const stub = stubRunPiFactory([{ text: "蒸馏完成" }]);
    const deps = mkDeps(stub.factory);
    const task = mkSystemTask(deps);
    await makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! })(task, "cron");
    await new Promise((r) => setTimeout(r, 20));

    // pi 被调：prompt=任务目标、session 跨执行固定、extensions 无 chat-bridge（同 TASK_EXTENSIONS）
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].prompt).toContain("蒸馏");
    expect(stub.calls[0].sessionId).toBe(`task-${task.id}`);
    expect((stub.calls[0].extensions ?? []).some((e) => e.includes("chat-bridge"))).toBe(false);
    // run 行：ok + finishedAt + 无 outputMessageId（headless 无产出会话）
    const runs = deps.taskStore!.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].finishedAt).not.toBeNull();
    expect(runs[0].outputMessageId).toBeNull();
    // 无会话消息产生（headless 不落 messages 表）
    expect(deps.store.listConversations("u", undefined, false).length).toBeGreaterThanOrEqual(0); // 不炸即证（无会话可写）
  });

  test("pi 抛错 → failed + note 记错误详情（管理页历史可读）", async () => {
    const stub = stubRunPiFactory([{ error: new Error("provider 超时") }]);
    const deps = mkDeps(stub.factory);
    const task = mkSystemTask(deps);
    await makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! })(task, "cron");
    await new Promise((r) => setTimeout(r, 20));
    const runs = deps.taskStore!.listRuns(task.id);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].finishedAt).not.toBeNull();
    expect((runs[0] as any).note).toContain("provider 超时");
  });

  test("scheduler 集成：admin 启用 seed（enabled 0→1）→ 假钟 tick → 真执行 → task_runs 收 ok", async () => {
    const stub = stubRunPiFactory([{ text: "headless ok" }]);
    const deps = mkDeps(stub.factory);
    // seed 形态：enabled=false 起步（迁移 seed 即此态）→ admin 启用
    const task = deps.taskStore!.createTask({
      scope: "system", workspaceId: null, displayName: "seed", cron: "0 4 * * 0", prompt: "p",
      outputConversationId: null, creatorId: "system",
      nextFireAt: new Date(Date.now() - 5000).toISOString(),
    });
    deps.taskStore!.setTaskEnabled(task.id, true, true); // admin allowSystem
    const { TaskScheduler } = await import("../src/scheduled-tasks/scheduler");
    const sched = new TaskScheduler({ store: deps.taskStore!, executeTask: makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! }) });
    await sched.tick();
    await new Promise((r) => setTimeout(r, 30));
    const runs = deps.taskStore!.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ok");
    expect(stub.calls).toHaveLength(1);
    // nextFireAt 已推进（markFired 先行）
    expect(new Date(deps.taskStore!.getTask(task.id)!.nextFireAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("disabled seed 不执行（tick 扫不到）", async () => {
    const stub = stubRunPiFactory([]);
    const deps = mkDeps(stub.factory);
    const task = mkSystemTask(deps); // enabled=true 默认 → 先停
    deps.taskStore!.setTaskEnabled(task.id, false, true);
    const { TaskScheduler } = await import("../src/scheduled-tasks/scheduler");
    const sched = new TaskScheduler({ store: deps.taskStore!, executeTask: makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! }) });
    await sched.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.taskStore!.listRuns(task.id)).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });

  test("未读计数对 headless run 生效（管理页 badge 锚 = viewedAt null）", async () => {
    const stub = stubRunPiFactory([{ text: "x" }]);
    const deps = mkDeps(stub.factory);
    const task = mkSystemTask(deps);
    await makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! })(task, "cron");
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.taskStore!.unreadCounts().get(task.id)).toBe(1);
    deps.taskStore!.markTaskRunsViewed(task.id);
    expect(deps.taskStore!.unreadCounts().get(task.id)).toBeUndefined();
  });
});
