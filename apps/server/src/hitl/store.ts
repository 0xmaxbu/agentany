// HitlStore（ADR-0030）：HITL 提问卡（ask/approval/task）持久化 + CAS 收口。
// insertQuestion/toQuestionRow 模块级导出——RunsStore 的原子挂起（suspendedStep）
// 在复合事务内复用同一字段集（code-review S2 单点收敛保）；context 走一等列（ADR-0030，退役 input 走私）。
import { and, desc, eq, isNull } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversations, hitlQuestions } from "../db/schema";
import { J, P, now } from "../db-utils";

export interface QuestionRow {
  id: number;
  conversationId: string;
  runId: string | null; // ask 卡绑挂起 run；approval 卡通过前无 run → 可空
  kind: "ask" | "approval" | "task";
  workflowId: string | null; // approval：待审批工作流（ask 卡为空）
  input: unknown; // approval：待审批 input（反序列化；approve 后用 createRun）
  prompt: string;
  options: unknown; // 反序列化 string[]（labels）
  values: unknown; // AskOption[] = 显式 {label,value} 快照（ask 强制卡）
  context: string | undefined; // ADR-0030：决策辅助 markdown 一等列（直读，不再 input 反解）
  resumeSchema: unknown; // 反序列化手搓 schema
  multiple: number; // 0/1
  status: "pending" | "answered";
  answer: unknown; // 反序列化 resumeData
  decidedBy: string | null; // approval：审批人 userId
  createdAt: string;
  answeredAt: string | null;
}

/** hitl_questions 插入收敛点（code-review S2）：createQuestion（裸库）与 RunsStore 复合事务共用字段集。 */
export function insertQuestion(
  exec: BunSQLiteDatabase | Parameters<Parameters<BunSQLiteDatabase["transaction"]>[0]>[0],
  v: typeof hitlQuestions.$inferInsert,
): number {
  const r = (exec as BunSQLiteDatabase)
    .insert(hitlQuestions)
    .values(v)
    .returning({ id: hitlQuestions.id })
    .get();
  if (!r) throw new Error(`insertQuestion: insert returned no row (prompt=${String(v.prompt).slice(0, 40)})`);
  return r.id;
}

/** 行 → 域模型（反序列化列；context 直列——旧 input-as-{context} 走私已随 ADR-0030 退役）。 */
export function toQuestionRow(r: any): QuestionRow {
  return {
    id: r.id, conversationId: r.conversationId, runId: r.runId, kind: r.kind ?? "ask",
    workflowId: r.workflowId, input: P(r.input), context: r.context ?? undefined, prompt: r.prompt,
    options: P(r.options), values: P(r.values), resumeSchema: P(r.resumeSchema), multiple: r.multiple,
    status: r.status as "pending" | "answered", answer: P(r.answer), decidedBy: r.decidedBy,
    createdAt: r.createdAt, answeredAt: r.answeredAt,
  };
}

export class HitlStore {
  constructor(private db: BunSQLiteDatabase<any>) {}

  createQuestion(p: {
    conversationId: string; runId?: string | null; prompt: string; options: unknown;
    values?: unknown; resumeSchema?: unknown; multiple?: boolean;
    kind?: "ask" | "approval" | "task"; workflowId?: string; input?: unknown; decidedBy?: string; context?: string;
  }): number {
    return insertQuestion(this.db, {
      conversationId: p.conversationId, runId: p.runId ?? null, kind: p.kind ?? "ask",
      workflowId: p.workflowId ?? null, input: J(p.input), prompt: p.prompt,
      options: J(p.options) as string, values: J(p.values), resumeSchema: J(p.resumeSchema),
      context: p.context ?? null,
      multiple: p.multiple ? 1 : 0, status: "pending", decidedBy: p.decidedBy ?? null, createdAt: now(),
    });
  }

  /** 全量 pending 卡（用户全部活跃会话，按 id 序）——T5 绑定补发扫描 / T6 文本回流三分支（ADR-0028 决策 3）。 */
  listPendingCardsForUser(userId: string): QuestionRow[] {
    return this.db.select()
      .from(hitlQuestions)
      .innerJoin(conversations, eq(hitlQuestions.conversationId, conversations.id))
      .where(and(
        eq(conversations.userId, userId),
        isNull(conversations.archivedAt),
        eq(hitlQuestions.status, "pending"),
      ))
      .orderBy(hitlQuestions.id)
      .all()
      .map((r) => toQuestionRow((r as any).hitl_questions));
  }

  listQuestions(conversationId: string, opts?: { includeAnswered?: boolean; kind?: "ask" | "approval" | "task" }): QuestionRow[] {
    const conds = [eq(hitlQuestions.conversationId, conversationId)];
    if (!opts?.includeAnswered) conds.push(eq(hitlQuestions.status, "pending"));
    if (opts?.kind) conds.push(eq(hitlQuestions.kind, opts.kind));
    return this.db.select().from(hitlQuestions).where(and(...conds)).orderBy(hitlQuestions.id).all()
      .map((r) => toQuestionRow(r as any));
  }

  getQuestion(id: number): QuestionRow | undefined {
    const r = this.db.select().from(hitlQuestions).where(eq(hitlQuestions.id, id)).get();
    return r ? toQuestionRow(r as any) : undefined;
  }

  /** 某 run 的 pending 提问（v1 一个 run 一个 pending）。幂等防护 + markAnswered 用。 */
  getPendingByRun(runId: string): QuestionRow | undefined {
    const r = this.db.select().from(hitlQuestions)
      .where(and(eq(hitlQuestions.runId, runId), eq(hitlQuestions.status, "pending")))
      .orderBy(hitlQuestions.id).get();
    return r ? toQuestionRow(r as any) : undefined;
  }

  /** 把某 run 的 pending 提问标 answered（存 pi 归一化 resumeData）。无 pending → undefined。 */
  markPendingAnsweredByRun(runId: string, answer: unknown): QuestionRow | undefined {
    const pending = this.getPendingByRun(runId);
    if (!pending) return undefined;
    this.db.update(hitlQuestions)
      .set({ status: "answered", answer: J(answer), answeredAt: now() })
      .where(eq(hitlQuestions.id, pending.id))
      .run();
    return this.getQuestion(pending.id);
  }

  /** 自主 ask 卡收口（ADR-0025 决策 10 修订）：回答即 solved。CAS pending→answered。 */
  markQuestionAnswered(id: number, answer: unknown): QuestionRow | undefined {
    const q = this.getQuestion(id);
    if (!q || q.status !== "pending") return undefined;
    this.db.update(hitlQuestions)
      .set({ status: "answered", answer: J(answer), answeredAt: now() })
      .where(and(eq(hitlQuestions.id, id), eq(hitlQuestions.status, "pending")))
      .run();
    return this.getQuestion(id);
  }

  /** #18：某 conv+workflow 的 pending 审批卡（幂等防护）。 */
  getPendingApproval(conversationId: string, workflowId: string): QuestionRow | undefined {
    const r = this.db.select().from(hitlQuestions)
      .where(and(
        eq(hitlQuestions.conversationId, conversationId),
        eq(hitlQuestions.workflowId, workflowId),
        eq(hitlQuestions.kind, "approval"),
        eq(hitlQuestions.status, "pending"),
      ))
      .orderBy(hitlQuestions.id).get();
    return r ? toQuestionRow(r as any) : undefined;
  }

  /** #18：标审批卡 answered + 回填 runId(approve)/decidedBy。CAS 防并发双击；非 pending → undefined。 */
  markApprovalDecided(id: number, answer: unknown, decidedBy: string, runId?: string): QuestionRow | undefined {
    const cur = this.getQuestion(id);
    if (!cur || cur.status !== "pending") return undefined;
    const res = this.db.update(hitlQuestions)
      .set({ status: "answered", answer: J(answer), decidedBy, runId: runId ?? cur.runId, answeredAt: now() })
      .where(and(eq(hitlQuestions.id, id), eq(hitlQuestions.status, "pending")))
      .run();
    if ((res as any).changes === 0) return undefined; // CAS 失败（并发双击之间被答）
    return this.getQuestion(id);
  }

  /** #18 approve 二阶段：claim 成功后才 createRun，再回填 runId。防并发双击各起一个 run。 */
  backfillApprovalRunId(id: number, runId: string): void {
    this.db.update(hitlQuestions).set({ runId }).where(eq(hitlQuestions.id, id)).run();
  }

  /** #18 approve 失败回滚：恢复 pending（清 answer/decidedBy/answeredAt）。CAS 防误回滚正常终结卡。 */
  reopenApproval(id: number): boolean {
    const res = this.db.update(hitlQuestions)
      .set({ status: "pending", answer: null, decidedBy: null, answeredAt: null })
      .where(and(eq(hitlQuestions.id, id), eq(hitlQuestions.status, "answered")))
      .run();
    return (res as any).changes > 0;
  }

  /** #28：任务卡落决（confirm/cancel）。CAS 防并发双击。 */
  markTaskCardDecided(id: number, answer: unknown): QuestionRow | undefined {
    const cur = this.getQuestion(id);
    if (!cur || cur.status !== "pending") return undefined;
    const res = this.db.update(hitlQuestions)
      .set({ status: "answered", answer: J(answer), answeredAt: now() })
      .where(and(eq(hitlQuestions.id, id), eq(hitlQuestions.status, "pending")))
      .run();
    if ((res as any).changes === 0) return undefined;
    return this.getQuestion(id);
  }
}