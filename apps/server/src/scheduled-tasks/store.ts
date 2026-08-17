// ScheduledTaskStore（#25/ADR-0021 切片 1）：三表唯一耦合 db 的类（与 WorkflowStore 共享同一 db）。
// 调度语义（markFired 先推进、strict missed、skipped_overrun）在 TaskScheduler（切片 #26）；
// 本文件只做 CRUD + 扫描查询 + system 保护。
import { and, eq, isNull, lte, ne, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { scheduledTasks, taskFiles, taskRuns } from "../db/schema";
import { nextFireAfter } from "./cron";
import type { WorkflowStore } from "../workflow-engine/store";

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
  allowWrite: boolean; // #39/ADR-0023：system 任务写权限（缺省开；false=全域只读，rw 仅 sessionDir）
  allowSearch: boolean; // #39/ADR-0023：搜索工具加载开关（缺省关；工具层权限非网络层）
}

export interface TaskRunRow {
  id: number;
  taskId: string;
  trigger: TaskRunTrigger;
  status: TaskRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  outputMessageId: string | null;
  note: string | null; // #32 headless 日志（失败详情；workspace 任务失败原因冗余）
  viewedAt: string | null;
}

/** ADR-0021 决策 7：system 任务只有 admin UI 可管——store 层兜底（路由/chat 同拒）。 */
export class SystemTaskProtected extends Error {
  constructor(id: string) { super(`system task protected: ${id}`); this.name = "SystemTaskProtected"; }
}

const now = (): string => new Date().toISOString();

export class ScheduledTaskStore {
  /** workflowStore：产出会话派生复用其 createConversation（#24 明文决策——会话语义单点）。 */
  constructor(private db: BunSQLiteDatabase<any>, private workflowStore?: WorkflowStore) {}

  createTask(p: {
    scope: TaskScope; workspaceId: string | null; displayName: string; cron: string; prompt: string;
    outputConversationId: string | null; creatorId: string; nextFireAt: string;
    allowWrite?: boolean; allowSearch?: boolean;
  }): ScheduledTaskRow {
    const row: ScheduledTaskRow = {
      id: "t_" + globalThis.crypto.randomUUID(),
      scope: p.scope, workspaceId: p.workspaceId, displayName: p.displayName, cron: p.cron,
      prompt: p.prompt, outputConversationId: p.outputConversationId, creatorId: p.creatorId,
      nextFireAt: p.nextFireAt, enabled: true, createdAt: now(),
      allowWrite: p.allowWrite ?? true, allowSearch: p.allowSearch ?? false,
    };
    this.db.insert(scheduledTasks).values(row).run();
    return row;
  }

  /**
   * 建 workspace 任务 + 事务内派生产出会话（#24：一处定死事务语义——切片 2 chat 建流复用）。
   * 会话行经 WorkflowStore.createConversation 生成（spec 明文复用；同 db 事务内写入），
   * 标题=displayName、挂任务同 ws、创建者=建任务用户（ADR-0021 决策 4）。
   */
  createWorkspaceTask(p: {
    displayName: string; cron: string; prompt: string; workspaceId: string; creatorId: string;
    firstFireAt: string;
  }): ScheduledTaskRow {
    const store = this.workflowStore;
    if (!store) throw new Error("createWorkspaceTask: workflowStore not provided");
    const taskId = "t_" + globalThis.crypto.randomUUID();
    const convId = "c_" + globalThis.crypto.randomUUID();
    let row: ScheduledTaskRow | undefined;
    this.db.transaction(() => {
      store.createConversation({ id: convId, workspaceId: p.workspaceId, userId: p.creatorId, title: p.displayName });
      this.db.insert(scheduledTasks).values({
        id: taskId, scope: "workspace", workspaceId: p.workspaceId, displayName: p.displayName,
        cron: p.cron, prompt: p.prompt, outputConversationId: convId, creatorId: p.creatorId,
        nextFireAt: p.firstFireAt, enabled: true, createdAt: now(),
        allowWrite: true, allowSearch: false, // workspace 任务不消费（缺省值显式落列）
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
    if (opts.includeSystem === false) conds.push(ne(scheduledTasks.scope, "system"));
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

  updateTask(id: string, patch: { displayName?: string; cron?: string; prompt?: string; nextFireAt?: string; allowWrite?: boolean; allowSearch?: boolean }, allowSystem = false): ScheduledTaskRow | undefined {
    const cur = this.getTask(id);
    if (!cur) return undefined;
    if (cur.scope === "system" && !allowSystem) throw new SystemTaskProtected(id); // #39：admin 路由传 true（chat/LLM 侧仍默认拒）
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
      startedAt: p.startedAt ?? null, finishedAt: null, outputMessageId: null, note: null, viewedAt: null,
    }).returning({ id: taskRuns.id }).get();
    if (!r) throw new Error("recordRun: insert returned no row");
    return r.id;
  }

  finishRun(id: number, p: { status: "ok" | "failed"; outputMessageId?: string | null; note?: string | null }): void {
    this.db.update(taskRuns)
      .set({ status: p.status, finishedAt: now(), outputMessageId: p.outputMessageId ?? null, note: p.note ?? null })
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

  /**
   * 启动 sweep（review c2）：执行中崩溃残留（recordRun 已落、finishRun 未到——
   * status=ok 且 finishedAt IS NULL）收为 failed。进程没了 run 不可能还在跑。
   * 返回收编行数（WorkflowStore.markRunningAsFailed 同款）。
   */
  sweepUnfinishedRuns(): number {
    const r = this.db.update(taskRuns)
      .set({ status: "failed", finishedAt: now() })
      .where(and(eq(taskRuns.status, "ok"), isNull(taskRuns.finishedAt)))
      .run();
    return (r as any).changes ?? 0;
  }

  // ── task_files（切片 3 写入；schema 本切片定型）──
  addTaskFile(p: { taskRunId: string; path: string; name: string }): number {
    const r = this.db.insert(taskFiles).values({ ...p, createdAt: now() })
      .returning({ id: taskFiles.id }).get();
    if (!r) throw new Error("addTaskFile: insert returned no row"); // fail-fast（recordRun 同款，不返假 id）
    return r.id;
  }

  listTaskFiles(taskRunId: string): { id: number; taskRunId: string; path: string; name: string; createdAt: string }[] {
    return this.db.select().from(taskFiles).where(eq(taskFiles.taskRunId, taskRunId)).all() as any;
  }

  /** #30：产出会话的文件列表（GET /conversations/:id/files 数据源）——按 run 分组、run 序，
   * 组内文件登记序。join task_files→task_runs→scheduled_tasks（outputConversationId 锚）。 */
  filesForConversation(conversationId: string): { runId: number; outputMessageId: string | null; files: { id: number; path: string; name: string; createdAt: string }[] }[] {
    const rows = this.db
      .select({
        runId: taskRuns.id,
        outputMessageId: taskRuns.outputMessageId,
        fileId: taskFiles.id,
        path: taskFiles.path,
        name: taskFiles.name,
        createdAt: taskFiles.createdAt,
      })
      .from(taskFiles)
      .innerJoin(taskRuns, eq(taskFiles.taskRunId, taskRuns.id))
      .innerJoin(scheduledTasks, eq(taskRuns.taskId, scheduledTasks.id))
      .where(eq(scheduledTasks.outputConversationId, conversationId))
      .orderBy(taskRuns.id, taskFiles.id)
      .all() as { runId: number; outputMessageId: string | null; fileId: number; path: string; name: string; createdAt: string }[];
    // 按 run 分组（一 run 多文件；一文件一组的多余行由分组吸收）
    const out: { runId: number; outputMessageId: string | null; files: { id: number; path: string; name: string; createdAt: string }[] }[] = [];
    for (const r of rows) {
      let g = out.find((x) => x.runId === r.runId);
      if (!g) {
        g = { runId: r.runId, outputMessageId: r.outputMessageId, files: [] };
        out.push(g);
      }
      g.files.push({ id: r.fileId, path: r.path, name: r.name, createdAt: r.createdAt });
    }
    return out;
  }
}
