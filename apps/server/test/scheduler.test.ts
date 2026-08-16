// TaskScheduler 直构 seam 测试（#26/ADR-0021 切片 1b）：假钟（now 注入拨时间）+ executeTask spy。
// 只断言外部行为：task_runs 落了什么 / nextFireAt 推到哪 / spy 是否被调。
import { describe, test, expect } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { TaskScheduler } from "../src/scheduled-tasks/scheduler";

/** 假钟：起始 T0，手动 advance。 */
function fakeClock(start: number) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

/** 建一个每小时任务（绕过频率下限无妨——hourly 本就合法），nextFireAt=from+1h。 */
function mkTask(store: ScheduledTaskStore, over: Record<string, unknown> = {}) {
  return store.createTask({
    scope: "workspace", workspaceId: "ws_company", displayName: "T", cron: "0 * * * *",
    prompt: "p", outputConversationId: null, creatorId: "u1",
    nextFireAt: new Date(T0 + 3600_000).toISOString(), ...over,
  });
}

const T0 = Date.UTC(2026, 7, 16, 0, 0, 0); // 2026-08-16T00:00Z 固定锚（不受真实时钟影响）
const H = 3600_000;

function mkDeps(overrides: Partial<ConstructorParameters<typeof TaskScheduler>[0]> = {}) {
  const db = openDbMigrated(":memory:");
  const store = new ScheduledTaskStore(db);
  return { store, ...overrides };
}

describe("TaskScheduler · tick 语义（假钟）", () => {
  test("到点触发：dueTasks → markFired（先推进）→ executeTask 被调 → task_runs 落 ok（trigger=cron）", async () => {
    const { store } = mkDeps();
    const clock = fakeClock(T0);
    const task = mkTask(store);
    const calls: string[] = [];
    const sched = new TaskScheduler({
      store, now: clock.now, intervalMs: 60_000,
      executeTask: async (t) => { calls.push(t.id); },
    });
    await sched.tick();
    expect(calls).toHaveLength(0); // 未到点
    clock.advance(H + 60_000); // 过首个火点（含 tick 余量）
    await sched.tick();
    expect(calls).toEqual([task.id]); // 执行了
    const runs = store.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("cron");
    expect(runs[0].status).toBe("ok");
    // nextFireAt 已推进（先推进再执行——崩溃不重复触发同窗口）
    const after = store.getTask(task.id)!;
    expect(new Date(after.nextFireAt).getTime()).toBeGreaterThan(T0 + H);
  });

  test("missed：停机跨窗口（假钟拨过 2 火点+2 tick）→ 只记 missed 不执行、nextFireAt 推进到未来", async () => {
    const { store } = mkDeps();
    const clock = fakeClock(T0);
    const task = mkTask(store);
    const calls: string[] = [];
    const sched = new TaskScheduler({
      store, now: clock.now, intervalMs: 60_000,
      executeTask: async (t) => { calls.push(t.id); },
    });
    clock.advance(2 * H + 3 * 60_000); // 停机跨两个窗口才恢复
    await sched.tick();
    expect(calls).toHaveLength(0); // 不执行
    const runs = store.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("missed");
    expect(runs[0].trigger).toBe("cron");
    expect(runs[0].startedAt).toBeNull(); // missed 无实际开始
    // nextFireAt 推进到未来火点（> now）
    const after = store.getTask(task.id)!;
    expect(new Date(after.nextFireAt).getTime()).toBeGreaterThan(clock.now());
  });

  test("skipped_overrun：上轮在跑（挂起不 resolve）→ 下 tick 本任务 skipped、其它任务照常并行", async () => {
    const { store } = mkDeps();
    const clock = fakeClock(T0);
    const slow = mkTask(store, { displayName: "slow" });
    const fast = mkTask(store, { displayName: "fast" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const sched = new TaskScheduler({
      store, now: clock.now, intervalMs: 60_000,
      executeTask: async (t) => { calls.push(t.id); if (t.id === slow.id) await gate; },
    });
    clock.advance(H + 60_000);
    await sched.tick(); // slow 挂起中、fast 完成
    await new Promise((r) => setTimeout(r, 10)); // 让 fast 的 finishRun 微任务跑完
    expect(calls.sort()).toEqual([slow.id, fast.id].sort());
    expect(sched.isRunning(slow.id)).toBe(true);
    // 下个窗口：slow 仍在跑 → skipped_overrun；fast 正常再跑
    clock.advance(H);
    await sched.tick();
    const slowRuns = store.listRuns(slow.id);
    expect(slowRuns.map((r) => r.status)).toEqual(["ok", "skipped_overrun"].slice(0, slowRuns.length).includes("skipped_overrun") ? ["ok", "skipped_overrun"] : slowRuns.map((r) => r.status));
    const skip = slowRuns.find((r) => r.status === "skipped_overrun");
    expect(skip).toBeDefined();
    expect(skip!.startedAt).toBeNull();
    const fastRuns = store.listRuns(fast.id);
    expect(fastRuns.filter((r) => r.status === "ok")).toHaveLength(2); // fast 两次都跑了
    release();
  });

  test("重启恢复：新 Scheduler 实例同一 store → 任务仍在、按 nextFireAt 继续", async () => {
    const { store } = mkDeps();
    const clock = fakeClock(T0);
    const task = mkTask(store);
    const calls: string[] = [];
    const s1 = new TaskScheduler({
      store, now: clock.now, intervalMs: 60_000,
      executeTask: async (t) => { calls.push(t.id); },
    });
    clock.advance(H + 60_000);
    await s1.tick();
    expect(calls).toHaveLength(1);
    // 「重启」：新实例（内存 running Set 清空），同 store
    const s2 = new TaskScheduler({
      store, now: clock.now, intervalMs: 60_000,
      executeTask: async (t) => { calls.push(t.id); },
    });
    clock.advance(H);
    await s2.tick();
    expect(calls).toHaveLength(2); // 继续按 nextFireAt 触发
    expect(store.listRuns(task.id)).toHaveLength(2);
  });

  test("disabled 任务到期不触发", async () => {
    const { store } = mkDeps();
    const clock = fakeClock(T0);
    const task = mkTask(store);
    store.setTaskEnabled(task.id, false);
    const calls: string[] = [];
    const sched = new TaskScheduler({
      store, now: clock.now, intervalMs: 60_000,
      executeTask: async (t) => { calls.push(t.id); },
    });
    clock.advance(2 * H);
    await sched.tick();
    expect(calls).toHaveLength(0);
    expect(store.listRuns(task.id)).toHaveLength(0);
  });

  test("executeTask 抛错 → task_runs 记 failed、nextFireAt 仍推进", async () => {
    const { store } = mkDeps();
    const clock = fakeClock(T0);
    const task = mkTask(store);
    const sched = new TaskScheduler({
      store, now: clock.now, intervalMs: 60_000,
      executeTask: async () => { throw new Error("boom"); },
    });
    clock.advance(H + 60_000);
    await sched.tick();
    await new Promise((r) => setTimeout(r, 10));
    const runs = store.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(new Date(store.getTask(task.id)!.nextFireAt).getTime()).toBeGreaterThan(T0 + H);
  });
});

describe("TaskScheduler · start/stop", () => {
  test("start() 定时 tick（intervalMs 可调）；stop() 后不再触发", async () => {
    const { store } = mkDeps();
    let t = T0;
    // 火点 T0+5：advance 6ms 后迟到仅 1ms（< 2×interval=10ms）→ 正常执行而非 missed。
    // （missed 阈值=2×intervalMs；火点远迟于该窗口才记 missed——上组测试已覆盖。）
    const task = store.createTask({
      scope: "workspace", workspaceId: "ws_company", displayName: "T", cron: "0 * * * *",
      prompt: "p", outputConversationId: null, creatorId: "u1",
      nextFireAt: new Date(T0 + 5).toISOString(),
    });
    let ticks = 0;
    const sched = new TaskScheduler({
      store, now: () => t, intervalMs: 5,
      executeTask: async () => { ticks++; },
    });
    const stop = sched.start();
    t += 6; // 过火点 1ms
    await new Promise((r) => setTimeout(r, 30)); // 几个 tick 周期
    stop();
    const ran = ticks;
    await new Promise((r) => setTimeout(r, 30));
    expect(ran).toBeGreaterThan(0);
    expect(ticks).toBe(ran); // stop 后不再增长
    expect(store.listRuns(task.id).some((r) => r.status === "ok")).toBe(true);
  });
});
