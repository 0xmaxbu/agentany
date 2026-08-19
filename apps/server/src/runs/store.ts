// RunsStore（ADR-0030）：run/log 域持久化——引擎（runner）唯一契约面。
// 跨域生命周期事务（setTerminalBrief / 原子挂起）按 subject 归属 run：message/question 写入是
// 同一 run 生命周期事务的副作用（崩溃窗口顺序约束是 run 关注点——ADR-0025 决策 2/3/6）。
// 类型 RunRow/LogRow/... 随文件走；序列化收紧在 db-utils（now/J/P 共享单调时钟）。
import { and, desc, eq, gt, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversations, messages, workflowRunLog, workflowRuns } from "../db/schema";
import { J, P, now } from "../db-utils";
import { insertQuestion } from "../hitl/store";

export type RunStatus = "running" | "suspended" | "completed" | "failed";
export type LogStatus = "running" | "completed" | "suspended" | "failed";

export interface AppendLogEntry {
  stepId: string;
  status: LogStatus;
  input?: unknown;
  output?: unknown;
  suspendPayload?: unknown;
  resumeSchema?: unknown;
  resumeData?: unknown;
}

export interface LogRow {
  seq: number;
  stepId: string;
  status: LogStatus;
  input: unknown;
  output: unknown;
  suspendPayload: unknown;
  resumeSchema: unknown;
  resumeData: unknown;
  ts: string;
}

export interface RunRow {
  runId: string;
  workflowId: string;
  workspaceId: string; // ADR-0018：run 挂 workspace（缺省公司 ws）
  conversationId: string | null;
  status: RunStatus;
  input: unknown;
  createdAt: string;
  updatedAt: string;
  // ADR-0025（#41）：terminal 简报——brief 与终态同事务写；briefMessageId 发信后回填（对账幂等锚）
  brief: string | null;
  briefMessageId: number | null;
}

export const runRow = (r: any): RunRow => ({ ...r, status: r.status as RunStatus, input: P(r.input) });

export class RunsStore {
  // store 只做泛化查询、不依赖 schema 的具体类型；<any> 绕开 BunSQLiteDatabase 泛型不协变。
  constructor(private db: BunSQLiteDatabase<any>) {}

  createRun(p: { runId: string; workflowId: string; workspaceId: string; conversationId?: string | null; input: unknown }): void {
    const ts = now();
    this.db
      .insert(workflowRuns)
      .values({
        runId: p.runId,
        workflowId: p.workflowId,
        workspaceId: p.workspaceId,
        conversationId: p.conversationId ?? null,
        status: "running",
        input: J(p.input) as string,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  }

  appendLog(runId: string, e: AppendLogEntry): number {
    const row = this.db
      .select({ m: sql<number>`coalesce(max(${workflowRunLog.seq}),0)+1` })
      .from(workflowRunLog)
      .where(eq(workflowRunLog.runId, runId))
      .get();
    const seq = row?.m ?? 1;
    this.db
      .insert(workflowRunLog)
      .values({
        runId,
        seq,
        stepId: e.stepId,
        status: e.status,
        input: J(e.input),
        output: J(e.output),
        suspendPayload: J(e.suspendPayload),
        resumeSchema: J(e.resumeSchema),
        resumeData: J(e.resumeData),
        ts: now(),
      })
      .run();
    return seq;
  }

  /** ADR-0031（G2）：log 行 + run status **同事务**（换步/终态原子——崩溃窗口归零）。runStatus 缺失 → 只落 log（中间步）。 */
  appendStep(runId: string, e: AppendLogEntry & { runStatus?: RunStatus }): number {
    let seq = 1;
    this.db.transaction((tx) => {
      const row = tx.select({ m: sql<number>`coalesce(max(${workflowRunLog.seq}),0)+1` }).from(workflowRunLog)
        .where(eq(workflowRunLog.runId, runId)).get();
      seq = row?.m ?? 1;
      tx.insert(workflowRunLog).values({
        runId, seq,
        stepId: e.stepId, status: e.status,
        input: J(e.input), output: J(e.output),
        suspendPayload: J(e.suspendPayload), resumeSchema: J(e.resumeSchema), resumeData: J(e.resumeData),
        ts: now(),
      }).run();
      if (e.runStatus !== undefined) {
        tx.update(workflowRuns).set({ status: e.runStatus, updatedAt: now() }).where(eq(workflowRuns.runId, runId)).run();
      }
    });
    return seq;
  }

  /** 会话的 run 列表（#53/T4：run 卡刷新恢复）——域表直读，createdAt 倒序（最新在前）。无 run → []。 */
  listRunsForConversation(conversationId: string): RunRow[] {
    const rows = this.db.select().from(workflowRuns)
      .where(eq(workflowRuns.conversationId, conversationId))
      .orderBy(desc(workflowRuns.createdAt))
      .all();
    return rows.map(runRow);
  }

  /** #53/T4：会话 run 列表 + 每 run 的 log 步骤收敛（一次批取，防 N+1）。步骤 status = 每步最新态；步骤序 = 首现 seq 序。 */
  listRunsWithSteps(conversationId: string): Array<RunRow & { steps: { stepId: string; status: LogStatus }[] }> {
    const runs = this.listRunsForConversation(conversationId);
    if (!runs.length) return [];
    const rows = this.db.select().from(workflowRunLog)
      .where(inArray(workflowRunLog.runId, runs.map((r) => r.runId)))
      .orderBy(workflowRunLog.seq)
      .all();
    const stepsByRun = new Map<string, Map<string, LogStatus>>();
    for (const l of rows) {
      const m = stepsByRun.get(l.runId);
      if (m) m.set(l.stepId, l.status as LogStatus);
      else stepsByRun.set(l.runId, new Map([[l.stepId, l.status as LogStatus]]));
    }
    return runs.map((r) => ({
      ...r,
      steps: [...(stepsByRun.get(r.runId) ?? new Map<string, LogStatus>())].map(([stepId, status]) => ({ stepId, status })),
    }));
  }

  getRun(runId: string): RunRow | undefined {
    const r = this.db.select().from(workflowRuns).where(eq(workflowRuns.runId, runId)).get();
    if (!r) return undefined;
    return runRow(r);
  }

  getLog(runId: string): LogRow[] {
    const rows = this.db
      .select()
      .from(workflowRunLog)
      .where(eq(workflowRunLog.runId, runId))
      .orderBy(workflowRunLog.seq)
      .all();
    return rows.map((r) => ({
      seq: r.seq,
      stepId: r.stepId,
      status: r.status as LogStatus,
      input: P(r.input),
      output: P(r.output),
      suspendPayload: P(r.suspendPayload),
      resumeSchema: P(r.resumeSchema),
      resumeData: P(r.resumeData),
      ts: r.ts,
    }));
  }

  updateRunStatus(runId: string, status: RunStatus): void {
    this.db
      .update(workflowRuns)
      .set({ status, updatedAt: now() })
      .where(eq(workflowRuns.runId, runId))
      .run();
  }

  // ── ADR-0025（#41/T1）：终态零 LLM 简报 ──

  /**
   * 终态 + brief + 简报消息 + briefMessageId 回填 + 会话 touch **同一 SQLite 事务**（崩溃封堵决策 3）。
   * 幂等 guard：briefMessageId 已非空 → 全程 no-op、返已有 id。消息只写有会话的 run；返消息 id（未发 → 0）。
   */
  setTerminalBrief(p: {
    runId: string;
    status: "completed" | "failed";
    brief: string;
    messageContent: string;
    conversationId: string | null;
  }): number {
    let messageId = 0;
    this.db.transaction((tx) => {
      const row = tx.select({ briefMessageId: workflowRuns.briefMessageId }).from(workflowRuns)
        .where(eq(workflowRuns.runId, p.runId)).get();
      if (row?.briefMessageId != null) { messageId = row.briefMessageId; return; } // 已发过：no-op（幂等）
      if (p.conversationId && p.messageContent) {
        const r = tx
          .insert(messages)
          .values({ conversationId: p.conversationId, role: "assistant", content: p.messageContent, createdAt: now() })
          .returning({ id: messages.id })
          .get();
        messageId = r?.id ?? 0;
        tx.update(conversations).set({ updatedAt: now() }).where(eq(conversations.id, p.conversationId)).run();
      }
      tx.update(workflowRuns)
        .set({ status: p.status, brief: p.brief, briefMessageId: messageId > 0 ? messageId : null, updatedAt: now() })
        .where(eq(workflowRuns.runId, p.runId))
        .run();
    });
    return messageId;
  }

  /** ADR-0025 决策 6 落实（G1）：挂起 = log(suspended) + run status + ask 卡 **同一事务**（孤儿窗口归零）。返 questionId。 */
  suspendedStep(p: {
    runId: string;
    stepId: string;
    input: unknown;
    suspendPayload: unknown; // ask 契约 payload（question/options/context）
    resumeSchema: unknown;
    conversationId: string;
    values: unknown; // AskOption[] 快照（显式 {label,value}，卡自包含）
  }): number {
    let qid = 0;
    this.db.transaction((tx) => {
      const row = tx.select({ m: sql<number>`coalesce(max(${workflowRunLog.seq}),0)+1` }).from(workflowRunLog)
        .where(eq(workflowRunLog.runId, p.runId)).get();
      const seq = row?.m ?? 1;
      tx.insert(workflowRunLog).values({
        runId: p.runId, seq, stepId: p.stepId, status: "suspended",
        input: J(p.input), suspendPayload: J(p.suspendPayload), resumeSchema: J(p.resumeSchema), ts: now(),
      }).run();
      tx.update(workflowRuns).set({ status: "suspended", updatedAt: now() }).where(eq(workflowRuns.runId, p.runId)).run();
      qid = this.insertCardInTx(tx, {
        runId: p.runId, conversationId: p.conversationId, prompt: "请继续",
        options: [], values: p.values, resumeSchema: p.resumeSchema, context: undefined,
      });
    });
    return qid;
  }

  /** ADR-0030：#官方 context 列退役走私前，A1 保留 legacy（A2 删除 deliverAskCard 后废弃）。 */
  suspendWithAskCard(p: {
    runId: string;
    conversationId: string;
    prompt: string;
    options: unknown; // labels string[]
    values: unknown; // AskOption[] 快照
    resumeSchema?: unknown;
    input?: unknown; // 兼容旧 {context} 包装（#67 前）；context 直列走 context 字段
    context?: string;
  }): number {
    let qid = 0;
    this.db.transaction((tx) => {
      tx.update(workflowRuns).set({ status: "suspended", updatedAt: now() }).where(eq(workflowRuns.runId, p.runId)).run();
      // 旧调用方仍传 input={context} → 拆出直列（000A1 期兼容；A2 删 legacy）
      const legacyContext = (() => {
        const i = P(p.input as string | null);
        return !!i && typeof i === "object" && typeof (i as { context?: unknown }).context === "string"
          ? (i as { context: string }).context : undefined;
      })();
      qid = this.insertCardInTx(tx, { runId: p.runId, conversationId: p.conversationId, prompt: p.prompt, options: p.options, values: p.values, resumeSchema: p.resumeSchema, context: p.context ?? legacyContext });
    });
    return qid;
  }

  private insertCardInTx(
    tx: Parameters<Parameters<BunSQLiteDatabase["transaction"]>[0]>[0],
    v: { runId: string; conversationId: string; prompt: string; options: unknown; values: unknown; resumeSchema?: unknown; context?: string },
  ): number {
    return insertQuestion(tx as any, {
      conversationId: v.conversationId, runId: v.runId, kind: "ask", input: null,
      prompt: v.prompt, options: J(v.options) as string, values: J(v.values),
      resumeSchema: J(v.resumeSchema), context: v.context ?? null,
      multiple: 0, status: "pending", createdAt: now(),
    });
  }

  reset(): void {
    this.db.delete(workflowRunLog).run();
    this.db.delete(workflowRuns).run();
  }

  // boot sweep——DB 里仍 running 的 run 标 failed，同步写 brief=「异常终止（进程重启）」（sweep 先于 reconcile）。
  markRunningAsFailed(): number {
    const r = this.db
      .update(workflowRuns)
      .set({ status: "failed", brief: "异常终止（进程重启）", updatedAt: now() })
      .where(eq(workflowRuns.status, "running"))
      .run();
    return (r as any).changes ?? 0;
  }

  /** 终态（completed/failed）且简报未发（brief_message_id NULL）且 brief 已写的 run——对账补发扫描键。排除已删会话。 */
  listTerminalRunsWithoutBriefMessage(): RunRow[] {
    const rows = this.db
      .select()
      .from(workflowRuns)
      .where(and(
        or(eq(workflowRuns.status, "completed"), eq(workflowRuns.status, "failed")),
        isNull(workflowRuns.briefMessageId),
        isNotNull(workflowRuns.brief),
        isNotNull(workflowRuns.conversationId),
      ))
      .all();
    return rows.map(runRow);
  }

  /** #17：某会话的挂起 run（带挂起步 stepId/payload/resumeSchema）。每轮 prompt 注入用。末条 log = 挂起步。 */
  listSuspendedRuns(conversationId: string): { runId: string; workflowId: string; stepId: string; payload: unknown; resumeSchema: unknown }[] {
    const runs = this.db.select().from(workflowRuns)
      .where(and(eq(workflowRuns.conversationId, conversationId), eq(workflowRuns.status, "suspended")))
      .all();
    return runs.map((r: any) => {
      const log = this.getLog(r.runId);
      const last = log[log.length - 1];
      return { runId: r.runId, workflowId: r.workflowId, stepId: last?.stepId ?? "", payload: last?.suspendPayload ?? null, resumeSchema: last?.resumeSchema ?? null };
    });
  }

  /** #19：某会话仍 running 的 runId（abort 用）。 */
  listRunningRunIds(conversationId: string): string[] {
    const rows = this.db.select({ runId: workflowRuns.runId }).from(workflowRuns)
      .where(and(eq(workflowRuns.conversationId, conversationId), eq(workflowRuns.status, "running")))
      .all();
    return rows.map((r: any) => r.runId);
  }
}