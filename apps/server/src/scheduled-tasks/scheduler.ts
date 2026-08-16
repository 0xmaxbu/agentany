// TaskScheduler（#26/ADR-0021 切片 1b）：进程内表驱动调度循环。
// 语义（spec #24 决策，用户已审核）：
//   - tick 每 intervalMs 扫 dueTasks（enabled && nextFireAt <= now）
//   - **markFired 先推进再执行**：执行中崩溃丢一次不补跑（missed 语义自然延伸）
//   - 严格 missed：nextFireAt 早于 now - 2×interval（停机跨窗口/边界抖动）→ 只记 missed 不执行
//   - 同任务在跑（running Set）→ 本轮 skipped_overrun；不同任务并行（异步不 await）
//   - 手动调用不经 tick（路由直调 runManual）：trigger=manual、不推进 nextFireAt
// DB 为真相：running Set 仅内存标记，重启即空（重启恢复 = 新实例按 nextFireAt 继续）。
import { nextFireAfter } from "./cron";
import type { ScheduledTaskRow, ScheduledTaskStore, TaskRunTrigger } from "./store";

export interface SchedulerDeps {
  store: ScheduledTaskStore;
  /** #29 真实现=makeExecuteTask（runTurn 同构、任务 pi 无 bridge）。runId 传入=收口责任移交。 */
  executeTask: (task: ScheduledTaskRow, trigger: TaskRunTrigger, runId?: number) => Promise<void>;
  now?: () => number; // 假钟注入（默认 Date.now）
  intervalMs?: number; // tick 周期（默认 60s；测试可调）
}

export class TaskScheduler {
  private running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(private deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? 60_000;
  }

  /** 手动/常规共用执行尾：登记 running、跑完由 executeTask 收口 run 行（#29 起全权——
   *  它知道 outputMessageId/错误语义）；runId 传入。executeTask 自身炸掉才兜底 failed。 */
  private async run(task: ScheduledTaskRow, trigger: "cron" | "manual", runId: number): Promise<void> {
    this.running.add(task.id);
    try {
      await this.deps.executeTask(task, trigger, runId);
    } catch (e) {
      this.log("task run failed:", task.id, e);
      this.deps.store.finishRun(runId, { status: "failed" });
    } finally {
      this.running.delete(task.id);
    }
  }

  /** 单次扫描。幂等、可重入；测试直调。分支序（spec 明文）：missed 判定 → running 判定 → 正常执行。 */
  async tick(): Promise<void> {
    const nowMs = this.now();
    const due = this.deps.store.dueTasks(new Date(nowMs).toISOString());
    for (const task of due) {
      const fireAt = new Date(task.nextFireAt).getTime();
      // 先推进再执行（崩溃=丢一次，不重复触发同窗口）
      this.deps.store.markFired(task.id, nextFireAfter(task.cron, new Date(nowMs)));
      // 严格 missed：到期早于 now-2×interval（停机跨窗、非本 tick 窗口内）→ 只记录不执行。
      // 判定先于 running——在跑任务跨窗恢复时按 missed 记（窗口早错过，非本轮拥堵）。
      if (fireAt < nowMs - 2 * this.intervalMs) {
        this.deps.store.recordRun({ taskId: task.id, trigger: "cron", status: "missed" });
        continue;
      }
      if (this.running.has(task.id)) {
        // 同任务上轮未完 → 本轮跳过（spec 故事 13：慢任务不自我堆叠；不同任务天然并行）
        this.deps.store.recordRun({ taskId: task.id, trigger: "cron", status: "skipped_overrun" });
        continue;
      }
      const runId = this.deps.store.recordRun({ taskId: task.id, trigger: "cron", status: "ok", startedAt: new Date(nowMs).toISOString() });
      void this.run(task, "cron", runId); // 异步不 await：跨任务并行；同任务靠 running Set 串行
    }
  }

  /**
   * 手动调用（spec 故事 4/7）：立即执行一次。不经 tick——不推进 nextFireAt；
   * 返回 runId；在跑 → undefined（路由 409）。
   */
  runManual(task: ScheduledTaskRow): number | undefined {
    if (this.running.has(task.id)) return undefined;
    const runId = this.deps.store.recordRun({ taskId: task.id, trigger: "manual", status: "ok", startedAt: new Date(this.now()).toISOString() });
    void this.run(task, "manual", runId);
    return runId;
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** 启动定时 tick。返回 stop（幂等）。 */
  start(): () => void {
    if (this.timer) return () => this.stop();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private log(...a: unknown[]): void {
    console.log("[scheduler]", ...a);
  }
}
