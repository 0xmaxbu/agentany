// #39/M6-1 执行层（seam ②）：system 任务权限三维度 → runPi 调用参数可观察结果。
// 不 spawn 真 pi——deps.runPiFn 直调注入（C1/#66，替代 spyOn 模块 mock）断言 prompt/session/extensions/sandboxAllow；
// fullDomainWorkspaceDirs 纯函数直测（全域解析+三域排除的白名单构成）。
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { ScheduledTaskStore, type ScheduledTaskRow } from "../src/scheduled-tasks/store";
import { makeExecuteTask, fullDomainWorkspaceDirs, TASK_EXTENSIONS } from "../src/scheduled-tasks/execute";
import { generalWorkspacePath, workspaceWorkspacePath, taskSessionDir, dataDir } from "../src/config";
import type { RunDeps } from "../src/runs";

// 隔离 DATA_DIR（防读写真实 data/）——dataDir() 动态读 env（#37 坑）
beforeEach(() => { process.env.DATA_DIR = "/tmp/agentany-test-fd-" + process.pid; });
afterEach(() => { delete process.env.DATA_DIR; });

function mkDeps(): RunDeps {
  const db = openDbMigrated(":memory:");
  const store = new WorkflowStore(db);
  return {
    store, userStore: new UserStore(db), streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db), taskStore: new ScheduledTaskStore(db, store),
    eventBus: new EventBus(),
  };
}

function mkSystemTask(deps: RunDeps, over: Partial<{ allowWrite: boolean; allowSearch: boolean }> = {}): ScheduledTaskRow {
  return deps.taskStore!.createTask({
    scope: "system", workspaceId: null, displayName: "巡检", cron: "0 5 * * 1", prompt: "汇总各 ws 产出",
    outputConversationId: null, creatorId: "system",
    nextFireAt: new Date().toISOString(),
    allowWrite: over.allowWrite, allowSearch: over.allowSearch,
  });
}

/** C1/#66：deps.runPiFn 直调注入（替代 spyOn 模块 mock）——记录 RunPiOptions 并回放 ok。 */
function stubRunPi(deps: RunDeps, calls: any[]): void {
  deps.runPiFn = async (opts: any) => {
    calls.push(opts);
    return { text: "ok", messages: [], toolResults: [] };
  };
}

describe("fullDomainWorkspaceDirs（ADR-0023 决策 1：全域白名单构成）", () => {
  test("公司 ws→general 路径 + 其余 ws→各自 workspace 目录；动态含新 ws", () => {
    const deps = mkDeps();
    const ws2 = deps.workspaceStore!.createWorkspace({ slug: "alpha", name: "Alpha" });
    const dirs = fullDomainWorkspaceDirs(deps.workspaceStore);
    expect(dirs).toContain(generalWorkspacePath());
    expect(dirs).toContain(workspaceWorkspacePath(ws2.id));
    // 新建 ws 再解析——自动纳入（动态）
    const ws3 = deps.workspaceStore!.createWorkspace({ slug: "beta", name: "Beta" });
    expect(fullDomainWorkspaceDirs(deps.workspaceStore)).toContain(workspaceWorkspacePath(ws3.id));
  });

  test("三域排除：白名单不含 db.sqlite / knowledge/ / pi-sessions", () => {
    const deps = mkDeps();
    deps.workspaceStore!.createWorkspace({ slug: "alpha", name: "A" });
    const dirs = fullDomainWorkspaceDirs(deps.workspaceStore).join("\n");
    expect(dirs).not.toContain("db.sqlite");
    expect(dirs).not.toContain("knowledge");
    expect(dirs).not.toContain("pi-sessions");
  });
});

describe("executeTask 通用 system 分支（权限三维度 → runPi 参数）", () => {
  test("allowWrite=true + allowSearch=true（缺省开关全开的对照态）", async () => {
    const deps = mkDeps();
    const ws2 = deps.workspaceStore!.createWorkspace({ slug: "alpha", name: "A" });
    const task = mkSystemTask(deps, { allowWrite: true, allowSearch: true });
    const calls: any[] = [];
    stubRunPi(deps, calls);
    await makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! })(task, "cron");
    expect(calls).toHaveLength(1);
    const o = calls[0];
    expect(o.prompt).toContain("汇总");
    expect(o.sessionId).toBe(`task-${task.id}`);
    expect(o.sessionDir).toBe(taskSessionDir(task.id)); // 任务专属（不与 chat 会话区混放）
    expect(o.cwd).toBe(generalWorkspacePath());
    expect(o.extensions).toEqual(TASK_EXTENSIONS); // allowSearch=true → 加载搜索扩展
    // 全域 rw：含 general + ws2；sessionDir 也在 rw
    expect(o.sandboxAllow.rw).toContain(generalWorkspacePath());
    expect(o.sandboxAllow.rw).toContain(workspaceWorkspacePath(ws2.id));
    expect(o.sandboxAllow.rw).toContain(taskSessionDir(task.id));
    expect(o.sandboxAllow.ro).not.toContain(generalWorkspacePath()); // rw 态工作区不重复进 ro
  });

  test("allowWrite=false：全域进 ro、rw 仅任务 sessionDir（全盘禁写）", async () => {
    const deps = mkDeps();
    const ws2 = deps.workspaceStore!.createWorkspace({ slug: "alpha", name: "A" });
    const task = mkSystemTask(deps, { allowWrite: false, allowSearch: false });
    const calls: any[] = [];
    stubRunPi(deps, calls);
    await makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! })(task, "cron");
    const o = calls[0];
    expect(o.sandboxAllow.rw).toEqual([taskSessionDir(task.id)]); // 唯一可写
    expect(o.sandboxAllow.ro).toContain(generalWorkspacePath()); // 全域只读
    expect(o.sandboxAllow.ro).toContain(workspaceWorkspacePath(ws2.id));
    expect(o.extensions).toEqual([]); // allowSearch=false → 无搜索工具
    // ro 不含任何 pi-sessions；knowledge 真相源时逐 skill 目录（非 knowledge 根）
    expect(o.sandboxAllow.ro.some((p: string) => p.includes("pi-sessions"))).toBe(false);
    expect(o.sandboxAllow.ro).not.toContain(dataDir() + "/knowledge"); // knowledge 根本身永不在列
  });

  test("ro 白名单精确到 skill 目录（knowledge 根/experience/learnings 不可见）", async () => {
    const deps = mkDeps();
    const task = mkSystemTask(deps, { allowWrite: false });
    const calls: any[] = [];
    stubRunPi(deps, calls);
    await makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! })(task, "cron");
    const ro: string[] = calls[0].sandboxAllow.ro;
    const kd = dataDir() + "/knowledge";
    // 无任何 ro 项是 knowledge 根本身或其 learnings/experience 子目录
    expect(ro.some((p) => p === kd || p === kd + "/experience" || p === kd + "/learnings")).toBe(false);
  });

  test("蒸馏 seed 特判回归：不进通用分支（runPi 不被调）", async () => {
    const deps = mkDeps();
    // 蒸馏走 runDistill——stub 它防真跑（runDistill 是模块函数，spy 换身）
    const distillMod = await import("../src/knowledge/distill");
    const spyDistill = spyOn(distillMod, "runDistill").mockImplementation(async () => ({ ok: true, note: "stub" }));
    try {
      const calls: any[] = [];
      stubRunPi(deps, calls);
      const task = deps.taskStore!.getTask("t_seed_distill")!; // 迁移 seed 已在
      await makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! })(task, "cron");
      expect(calls).toHaveLength(0); // 蒸馏不经通用 pi 通道
      expect(spyDistill).toHaveBeenCalled();
    } finally { spyDistill.mockRestore(); }
  });
});
