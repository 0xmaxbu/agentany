// Drizzle 版 WorkflowStore（替 spike-b 裸 bun:sqlite；方法同 spike-b）。
// 这是引擎里唯一耦合 db 的文件；runner 只接收本类实例、不 import db。
import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversations, feedback, hitlQuestions, messages, workflowRunLog, workflowRuns } from "../db/schema";

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
}

export interface FeedbackRow {
  id: number;
  targetKind: string;
  targetId: string;
  text: string;
  rating: number | null;
  createdAt: string;
}

export interface ConversationRow {
  id: string;
  workspaceId: string; // ADR-0018：会话挂 workspace（缺省公司 ws）
  userId: string; // 创建者（会话一律创建者私有）
  title: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null; // #21/ADR-0020：null=活跃；归档软态
}

export interface MessageRow {
  id: number;
  conversationId: string;
  role: string; // user | assistant
  content: string;
  attachments: unknown;
  createdAt: string;
}

// HITL 提问（ticket #16 ask_user + #18 审批门）：ask_user 异步建 pending；resume 成功 markAnswered。
export interface QuestionRow {
  id: number;
  conversationId: string;
  runId: string | null; // #16 ask 卡绑挂起 run；#18 approval 卡通过前无 run → 可空
  kind: "ask" | "approval"; // #16 ask | #18 approval
  workflowId: string | null; // #18 approval：待审批工作流（ask 卡为空）
  input: unknown; // #18 approval：待审批 input（反序列化；approve 后用它 createRun）
  prompt: string;
  options: unknown; // 反序列化 string[]
  resumeSchema: unknown; // 反序列化手搓 schema
  multiple: number; // 0/1
  status: "pending" | "answered";
  answer: unknown; // 反序列化 resumeData（ask：pi 归一化答案；approval：{decision}）
  decidedBy: string | null; // #18 approval：审批人 userId（ask 卡为空）
  createdAt: string;
  answeredAt: string | null;
}

const J = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const P = (s: string | null): unknown => (s != null ? JSON.parse(s) : null);
// 单调递增时间戳：同毫秒连续操作（测试/批量建会话）保持严格先后——updatedAt 倒序锚
// 不退化成插入序，touch「排最前」语义毫秒内也成立。
let lastTs = 0;
const now = (): string => {
  const t = Date.now();
  lastTs = t > lastTs ? t : lastTs + 1;
  return new Date(lastTs).toISOString();
};

export class WorkflowStore {
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

  getRun(runId: string): RunRow | undefined {
    const r = this.db.select().from(workflowRuns).where(eq(workflowRuns.runId, runId)).get();
    if (!r) return undefined;
    return { ...r, status: r.status as RunStatus, input: P(r.input) };
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

  reset(): void {
    this.db.delete(workflowRunLog).run();
    this.db.delete(workflowRuns).run();
  }

  // ticket #14：boot sweep——把 DB 里仍 running 的 run 标 failed（v1 假设步幂等；真崩溃恢复后续）。
  markRunningAsFailed(): number {
    const r = this.db
      .update(workflowRuns)
      .set({ status: "failed", updatedAt: now() })
      .where(eq(workflowRuns.status, "running"))
      .run();
    return (r as any).changes ?? 0;
  }

  /** #17：某会话的挂起 run（带挂起步 stepId/payload/resumeSchema）。每轮 prompt 注入用。末条 log = 挂起步（runner.ts:30 同假设）。 */
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

  /** #19：某会话仍 running 的 runId（abort 用：停该会话所有在跑 run）。 */
  listRunningRunIds(conversationId: string): string[] {
    const rows = this.db.select({ runId: workflowRuns.runId }).from(workflowRuns)
      .where(and(eq(workflowRuns.conversationId, conversationId), eq(workflowRuns.status, "running")))
      .all();
    return rows.map((r: any) => r.runId);
  }

  // ── 反馈（ADR-0008，多态挂载到任意执行）──
  addFeedback(p: { targetKind: string; targetId: string; text: string; rating?: number }): number {
    const r = this.db
      .insert(feedback)
      .values({ targetKind: p.targetKind, targetId: p.targetId, text: p.text, rating: p.rating ?? null, createdAt: now() })
      .returning({ id: feedback.id })
      .get();
    return r?.id ?? 0;
  }

  getFeedback(targetKind: string, targetId: string): FeedbackRow[] {
    return this.db
      .select()
      .from(feedback)
      .where(and(eq(feedback.targetKind, targetKind), eq(feedback.targetId, targetId)))
      .orderBy(feedback.id)
      .all();
  }

  // ── chat 切片①（ADR-0009：1 会话 = 1 Pi session）──
  createConversation(p: { id: string; workspaceId: string; userId: string; title?: string }): ConversationRow {
    const ts = now();
    this.db
      .insert(conversations)
      .values({ id: p.id, workspaceId: p.workspaceId, userId: p.userId, title: p.title ?? null, createdAt: ts, updatedAt: ts })
      .run();
    return { id: p.id, workspaceId: p.workspaceId, userId: p.userId, title: p.title ?? null, createdAt: ts, updatedAt: ts, archivedAt: null };
  }

  getConversation(id: string): ConversationRow | undefined {
    const r = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    return r ? (r as ConversationRow) : undefined;
  }

  /** 会话活跃触达（#20）：updatedAt = 列表排序锚（此前建后无人更新，倒序退化成插入序）。no-op 安全。 */
  touchConversation(id: string): void {
    this.db.update(conversations).set({ updatedAt: now() }).where(eq(conversations.id, id)).run();
  }

  /** 创建者的会话列表（#20/f2：前端按 ws 分组）。updatedAt 倒序（id 破并列——分页翻页稳定）。
   * #21：默认只活跃，archived=true 反向。#手风琴：limit/offset 分页（无参全量）。 */
  listConversations(userId: string, workspaceId?: string, archived = false, limit?: number, offset?: number): ConversationRow[] {
    const conds = [eq(conversations.userId, userId)];
    if (workspaceId) conds.push(eq(conversations.workspaceId, workspaceId));
    conds.push(archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt));
    const q = this.db
      .select()
      .from(conversations)
      .where(and(...conds))
      .orderBy(desc(conversations.updatedAt), desc(conversations.id));
    const rows = (limit !== undefined ? q.limit(limit).offset(offset ?? 0) : q).all();
    return rows as unknown as ConversationRow[];
  }

  /** #21/ADR-0020 归档（幂等：已归档不动时间戳）。返回更新后行；不存在 undefined。 */
  archiveConversation(id: string): ConversationRow | undefined {
    const conv = this.getConversation(id);
    if (!conv) return undefined;
    if (conv.archivedAt) return conv;
    const archivedAt = now();
    this.db.update(conversations).set({ archivedAt }).where(eq(conversations.id, id)).run();
    return { ...conv, archivedAt };
  }

  /** #21/ADR-0020 恢复（幂等：未归档 no-op）。返回更新后行；不存在 undefined。 */
  restoreConversation(id: string): ConversationRow | undefined {
    const conv = this.getConversation(id);
    if (!conv) return undefined;
    if (!conv.archivedAt) return conv;
    this.db.update(conversations).set({ archivedAt: null }).where(eq(conversations.id, id)).run();
    return { ...conv, archivedAt: null };
  }

  /**
   * #21/ADR-0020 硬删（admin-only，全链清理，单事务）：
   * conversations/messages/hitl_questions 行删；workflow_runs.conversationId 置空解绑
   * （run 属 workspace 资产非会话子资产，ADR-0018；suspended run 无进程不杀）。
   * pi session jsonl unlink 不在此（文件系统副作用——路由层做，DB 保持纯）。
   */
  deleteConversation(id: string): boolean {
    const conv = this.getConversation(id);
    if (!conv) return false;
    this.db.transaction((tx) => {
      tx.delete(conversations).where(eq(conversations.id, id)).run();
      tx.delete(messages).where(eq(messages.conversationId, id)).run();
      tx.delete(hitlQuestions).where(eq(hitlQuestions.conversationId, id)).run();
      tx.update(workflowRuns).set({ conversationId: null }).where(eq(workflowRuns.conversationId, id)).run();
    });
    return true;
  }

  appendMessage(p: { conversationId: string; role: string; content: string; attachments?: unknown }): number {
    const r = this.db
      .insert(messages)
      .values({
        conversationId: p.conversationId,
        role: p.role,
        content: p.content,
        attachments: J(p.attachments),
        createdAt: now(),
      })
      .returning({ id: messages.id })
      .get();
    return r?.id ?? 0;
  }

  listMessages(conversationId: string): MessageRow[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.id)
      .all()
      .map((r) => ({ ...r, attachments: P((r as any).attachments) }));
  }

  // ── HITL 提问（ticket #16 ask_user + #18 审批门）──
  createQuestion(p: {
    conversationId: string; runId?: string | null; prompt: string; options: unknown;
    resumeSchema?: unknown; multiple?: boolean;
    kind?: "ask" | "approval"; workflowId?: string; input?: unknown; decidedBy?: string;
  }): number {
    const r = this.db
      .insert(hitlQuestions)
      .values({
        conversationId: p.conversationId, runId: p.runId ?? null, kind: p.kind ?? "ask",
        workflowId: p.workflowId ?? null, input: J(p.input), prompt: p.prompt,
        options: J(p.options) as string, resumeSchema: J(p.resumeSchema),
        multiple: p.multiple ? 1 : 0, status: "pending", decidedBy: p.decidedBy ?? null, createdAt: now(),
      })
      .returning({ id: hitlQuestions.id })
      .get();
    if (!r) throw new Error("createQuestion: insert returned no row"); // fail-fast：插入失败不静默返 0（否则 ask_user/审批门会渲染 id=0 假卡，点批准必 404）
    return r.id;
  }

  listQuestions(conversationId: string, opts?: { includeAnswered?: boolean; kind?: "ask" | "approval" }): QuestionRow[] {
    const conds = [eq(hitlQuestions.conversationId, conversationId)];
    if (!opts?.includeAnswered) conds.push(eq(hitlQuestions.status, "pending"));
    if (opts?.kind) conds.push(eq(hitlQuestions.kind, opts.kind));
    return this.db.select().from(hitlQuestions).where(and(...conds)).orderBy(hitlQuestions.id).all()
      .map((r) => this.toQuestionRow(r as any));
  }

  getQuestion(id: number): QuestionRow | undefined {
    const r = this.db.select().from(hitlQuestions).where(eq(hitlQuestions.id, id)).get();
    return r ? this.toQuestionRow(r as any) : undefined;
  }

  /** 某 run 的 pending 提问（v1 一个 run 一个 pending）。幂等防护 + markAnswered 用。 */
  getPendingByRun(runId: string): QuestionRow | undefined {
    const r = this.db.select().from(hitlQuestions)
      .where(and(eq(hitlQuestions.runId, runId), eq(hitlQuestions.status, "pending")))
      .orderBy(hitlQuestions.id).get();
    return r ? this.toQuestionRow(r as any) : undefined;
  }

  /** 把某 run 的 pending 提问标 answered（存 pi 归一化后的 resumeData）。无 pending → undefined。 */
  markPendingAnsweredByRun(runId: string, answer: unknown): QuestionRow | undefined {
    const pending = this.getPendingByRun(runId);
    if (!pending) return undefined;
    this.db.update(hitlQuestions)
      .set({ status: "answered", answer: J(answer), answeredAt: now() })
      .where(eq(hitlQuestions.id, pending.id))
      .run();
    return this.getQuestion(pending.id);
  }

  /** #18：某 conv+workflow 的 pending 审批卡（幂等防护：同 conv+workflow 已有 pending 则不建新）。 */
  getPendingApproval(conversationId: string, workflowId: string): QuestionRow | undefined {
    const r = this.db.select().from(hitlQuestions)
      .where(and(
        eq(hitlQuestions.conversationId, conversationId),
        eq(hitlQuestions.workflowId, workflowId),
        eq(hitlQuestions.kind, "approval"),
        eq(hitlQuestions.status, "pending"),
      ))
      .orderBy(hitlQuestions.id).get();
    return r ? this.toQuestionRow(r as any) : undefined;
  }

  /** #18：标审批卡 answered + 回填 runId(approve)/decidedBy。CAS（WHERE id AND status='pending'）防并发双击；非 pending → undefined。 */
  markApprovalDecided(id: number, answer: unknown, decidedBy: string, runId?: string): QuestionRow | undefined {
    const cur = this.getQuestion(id);
    if (!cur || cur.status !== "pending") return undefined; // 已不存在/已答
    const res = this.db.update(hitlQuestions)
      .set({ status: "answered", answer: J(answer), decidedBy, runId: runId ?? cur.runId, answeredAt: now() })
      .where(and(eq(hitlQuestions.id, id), eq(hitlQuestions.status, "pending")))
      .run();
    if ((res as any).changes === 0) return undefined; // CAS 失败（并发双击之间被答）
    return this.getQuestion(id);
  }

  /** #18 approve 二阶段：claim（markApprovalDecided 不带 runId）成功后才 createRun，再回填 runId。防并发双击各起一个 run。 */
  backfillApprovalRunId(id: number, runId: string): void {
    this.db.update(hitlQuestions).set({ runId }).where(eq(hitlQuestions.id, id)).run();
  }

  /** #18 approve 失败回滚：start() 抛错/非 running 时把已 claim 的卡恢复 pending（清 answer/decidedBy/answeredAt），允许重试。
   *  CAS（WHERE id AND status='answered'）防误回滚正常终结的卡。返是否回滚成功。 */
  reopenApproval(id: number): boolean {
    const res = this.db.update(hitlQuestions)
      .set({ status: "pending", answer: null, decidedBy: null, answeredAt: null })
      .where(and(eq(hitlQuestions.id, id), eq(hitlQuestions.status, "answered")))
      .run();
    return (res as any).changes > 0;
  }

  private toQuestionRow(r: any): QuestionRow {
    return {
      id: r.id, conversationId: r.conversationId, runId: r.runId, kind: r.kind ?? "ask",
      workflowId: r.workflowId, input: P(r.input), prompt: r.prompt,
      options: P(r.options), resumeSchema: P(r.resumeSchema), multiple: r.multiple,
      status: r.status as "pending" | "answered", answer: P(r.answer), decidedBy: r.decidedBy,
      createdAt: r.createdAt, answeredAt: r.answeredAt,
    };
  }
}
