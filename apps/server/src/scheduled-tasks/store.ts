// ScheduledTaskStore（#25/ADR-0021 切片 1）：三表唯一耦合 db 的类（与 WorkflowStore 共享同一 db）。
// 调度语义（markFired 先推进、strict missed、skipped_overrun）在 TaskScheduler（切片 #26）；
// 本文件只做 CRUD + 扫描查询 + system 保护。
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversations as conversationsTable, scheduledTasks, taskFiles, taskRuns } from "../db/schema";
import { nextFireAfter } from "./cron";

export type TaskScope = "workspace" | "system";
export type TaskRunStatus = "ok" | "failed" | "missed" | "skipped_overrun";
export type TaskRunTrigger = "cron" | "manual";

export interface ScheduledTaskRow {
  id: string;
  scope: TaskScope;
  workspaceId: string | null;
  displayName: string;
  cron: string;
  prompt: string;
  outputConversationId: string | null;
  creatorId: string;
  nextFireAt: string;
  enabled: boolean;
  createdAt: string;
}

export interface TaskRunRow {
  id: number;
  taskId: string;
  trigger: TaskRunTrigger;
  status: TaskRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  outputMessageId: string | null;
  viewedAt: string | null;
}

/** ADR-0021 决策 7：system 任务只有 admin UI 可管——store 层兜底（路由/chat 同拒）。 */
export class SystemTaskProtected extends Error {
  constructor(id: string) { super(`system task protected: ${id}`); this.name = "SystemTaskProtected"; }
}

const now = (): string => new Date().toISOString();

export class ScheduledTaskStore {
  constructor(private db: BunSQLiteDatabase<any>) {}

  createTask(p: {
    scope: TaskScope; workspaceId: string | null; displayName: string; cron: string; prompt: string;
    outputConversationId: string | null; creatorId: string; nextFireAt: string;
  }): ScheduledTaskRow {
    const row: ScheduledTaskRow = {
      id: "t_" + globalThis.crypto.randomUUID(),
      scope: p.scope, workspaceId: p.workspaceId, displayName: p.displayName, cron: p.cron,
      prompt: p.prompt, outputConversationId: p.outputConversationId, creatorId: p.creatorId,
      nextFireAt: p.nextFireAt, enabled: true, createdAt: now(),
    };
    this.db.insert(scheduledTasks).values(row).run();
    return row;
  }

  /**
   * 建 workspace 任务 + 事务内派生产出会话（#24：一处定死事务语义——切片 2 chat 建流复用）。
   * 会话标题=displayName、挂任务同 ws、创建者=建任务用户（ADR-0021 决策 4）。
   * 事务只包两张表写入（conversations 行 + scheduled_tasks 行）——id 由调用侧生成传入，
   * 保证回滚时不留半链（会话无任务/任务无会话）。
   */
  createWorkspaceTask(p: {
    displayName: string; cron: string; prompt: string; workspaceId: string; creatorId: string;
    firstFireAt: string; makeTaskId?: () => string; makeConversationId?: () => string;
  }): ScheduledTaskRow {
    const taskId = p.makeTaskId?.() ?? "t_" + globalThis.crypto.randomUUID();
    const convId = "c_" + globalThis.crypto.randomUUID();
    const ts = now();
    let row: ScheduledTaskRow | undefined;
    this.db.transaction((tx) => {
      tx.insert(scheduledTasks).values({
        id: taskId, scope: "workspace", workspaceId: p.workspaceId, displayName: p.displayName,
        cron: p.cron, prompt: p.prompt, outputConversationId: convId, creatorId: p.creatorId,
        nextFireAt: p.firstFireAt, enabled: true, createdAt: ts,
      }).run();
      tx.insert(conversationsTable).values({
        id: convId, workspaceId: p.workspaceId, userId: p.creatorId, title: p.displayName,
        createdAt: ts, updatedAt: ts,
      }).run();
      row = this.getTask(taskId);
    });
    if (!row) throw new Error("createWorkspaceTask: transaction left no row");
    return row;
  }

  /** 重算 nextFireAt（改 cron 后）。非法 cron 抛 InvalidCron。 */
  recomputeNextFire(id: string, from: Date = new Date()): string {
    const t = this.getTask(id);
    if (!t) throw new Error(`task not found: ${id}`);
    const nf = nextFireAfter(t.cron, from);
    this.db.update(scheduledTasks).set({ nextFireAt: nf }).where(eq(scheduledTasks.id, id)).run();
    return nf;
  }

  /** seed 行惰性补算（迁移 seed 的 nextFireAt=epoch 占位；启动时对 enabled=0 且 epoch 的行算真值但保持 disabled——M5 装配时启用）。 */
  reviveSeedNextFire(): void {
    const seeds = this.db.select().from(scheduledTasks)
      .where(and(eq(scheduledTasks.scope, "system"), eq(scheduledTasks.nextFireAt, "1970-01-01T00:00:00.000Z")))
      .all() as ScheduledTaskRow[];
    for (const s of seeds) {
      const nf = nextFireAfter(s.cron, new Date());
      this.db.update(scheduledTasks).set({ nextFireAt: nf }).where(eq(scheduledTasks.id, s.id)).run();
    }
  }

  getTask(id: string): ScheduledTaskRow | undefined {
    const r = this.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get();
    return r ? (r as ScheduledTaskRow) : undefined;
  }

  /** 任务列表。creatorId 过滤=member 只见自己的；includeSystem=false 剔 system（seed 对 member 不可见）。 */
  listTasks(opts: { creatorId?: string; includeSystem?: boolean } = {}): ScheduledTaskRow[] {
    const conds = [];
    if (opts.creatorId) conds.push(eq(scheduledTasks.creatorId, opts.creatorId));
    if (opts.includeSystem === false) conds.push(sql`${scheduledTasks.scope} != 'system'`);
    const q = this.db.select().from(scheduledTasks);
    return (conds.length ? q.where(and(...conds)) : q).orderBy(scheduledTasks.createdAt).all() as ScheduledTaskRow[];
  }

  /** 调度扫描：enabled 且到点。 */
  dueTasks(nowIso: string): ScheduledTaskRow[] {
    return this.db.select().from(scheduledTasks)
      .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextFireAt, nowIso)))
      .orderBy(scheduledTasks.nextFireAt)
      .all() as ScheduledTaskRow[];
  }

  /** 执行前推进（#24 决策：先推进再执行——执行中崩溃丢一次不补跑）。nextFireAt=下一个未来火点。 */
  markFired(id: string, nextFireAt: string): void {
    this.db.update(scheduledTasks).set({ nextFireAt }).where(eq(scheduledTasks.id, id)).run();
  }

  updateTask(id: string, patch: { displayName?: string; cron?: string; prompt?: string; nextFireAt?: string }): ScheduledTaskRow | undefined {
    const cur = this.getTask(id);
    if (!cur) return undefined;
    if (cur.scope === "system") throw new SystemTaskProtected(id);
    this.db.update(scheduledTasks).set(patch).where(eq(scheduledTasks.id, id)).run();
    return this.getTask(id);
  }

  /** enabled 翻转。system 保护走 allowSystem（admin 路由 true / member+chat false）。 */
  setTaskEnabled(id: string, enabled: boolean, allowSystem = false): ScheduledTaskRow | undefined {
    const cur = this.getTask(id);
    if (!cur) return undefined;
    if (cur.scope === "system" && !allowSystem) throw new SystemTaskProtected(id);
    this.db.update(scheduledTasks).set({ enabled }).where(eq(scheduledTasks.id, id)).run();
    return this.getTask(id);
  }

  deleteTask(id: string, allowSystem = false): boolean {
    const cur = this.getTask(id);
    if (!cur) return false;
    if (cur.scope === "system" && !allowSystem) throw new SystemTaskProtected(id);
    const runIds = (this.db.select({ id: taskRuns.id }).from(taskRuns).where(eq(taskRuns.taskId, id)).all() as { id: number }[])
      .map((r) => String(r.id));
    this.db.transaction((tx) => {
      tx.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).run();
      tx.delete(taskRuns).where(eq(taskRuns.taskId, id)).run();
      for (const rid of runIds) tx.delete(taskFiles).where(eq(taskFiles.taskRunId, rid)).run();
    });
    return true;
  }

  // ── task_runs（#26 调度循环写入；本切片定型 schema + 基础查询）──

  recordRun(p: { taskId: string; trigger: TaskRunTrigger; status: TaskRunStatus; startedAt?: string | null }): number {
    const r = this.db.insert(taskRuns).values({
      taskId: p.taskId, trigger: p.trigger, status: p.status,
      startedAt: p.startedAt ?? null, finishedAt: null, outputMessageId: null, viewedAt: null,
    }).returning({ id: taskRuns.id }).get();
    if (!r) throw new Error("recordRun: insert returned no row");
    return r.id;
  }

  finishRun(id: number, p: { status: "ok" | "failed"; outputMessageId?: string | null }): void {
    this.db.update(taskRuns)
      .set({ status: p.status, finishedAt: now(), outputMessageId: p.outputMessageId ?? null })
      .where(eq(taskRuns.id, id)).run();
  }

  listRuns(taskId: string): TaskRunRow[] {
    return this.db.select().from(taskRuns)
      .where(eq(taskRuns.taskId, taskId)).orderBy(taskRuns.id).all() as TaskRunRow[];
  }

  /** 各任务未读执行数（system 任务 badge 锚；viewedAt IS NULL 计数）。 */
  unreadCounts(): Map<string, number> {
    const rows = this.db.select({ taskId: taskRuns.taskId, n: sql<number>`count(*)` })
      .from(taskRuns).where(isNull(taskRuns.viewedAt))
      .groupBy(taskRuns.taskId).all();
    return new Map(rows.map((r: any) => [r.taskId, Number(r.n)]));
  }

  /** 点开即清（#24）：某任务全部未读盖 viewedAt。 */
  markTaskRunsViewed(taskId: string): void {
    this.db.update(taskRuns).set({ viewedAt: now() })
      .where(and(eq(taskRuns.taskId, taskId), isNull(taskRuns.viewedAt))).run();
  }

  // ── task_files（切片 3 写入；schema 本切片定型）──
  addTaskFile(p: { taskRunId: string; path: string; name: string }): number {
    const r = this.db.insert(taskFiles).values({ ...p, createdAt: now() })
      .returning({ id: taskFiles.id }).get();
    return r?.id ?? 0;
  }

  listTaskFiles(taskRunId: string): { id: number; taskRunId: string; path: string; name: string; createdAt: string }[] {
    return this.db.select().from(taskFiles).where(eq(taskFiles.taskRunId, taskRunId)).all() as any;
  }
}
