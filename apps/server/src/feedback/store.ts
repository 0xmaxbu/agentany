// FeedbackStore（ADR-0030）：反馈（ADR-0008 多态挂载 message/workflow_run/chat）持久化 + 蒸馏增量水位。
// conversationOfFeedbackTarget 反查跨表（messages/workflowRuns）按 subject=反馈挂载目标归属本域。
import { and, eq, gt, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversations, feedback, messages, workflowRuns } from "../db/schema";
import { now } from "../db-utils";
import type { ConversationRow } from "../chat/store"; // 反馈反查会话（权限锚）复用 chat 域行类型

export interface FeedbackRow {
  id: number;
  targetKind: string;
  targetId: string;
  text: string;
  rating: number | null;
  authorId: string | null; // #34 审查 Spec-4：作者（回显按人过滤）
  createdAt: string;
}

export class FeedbackStore {
  constructor(private db: BunSQLiteDatabase<any>) {}

  addFeedback(p: { targetKind: string; targetId: string; text: string; rating?: number; authorId?: string }): number {
    const r = this.db
      .insert(feedback)
      .values({ targetKind: p.targetKind, targetId: p.targetId, text: p.text, rating: p.rating ?? null, authorId: p.authorId ?? null, createdAt: now() })
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

  // ── #36 蒸馏增量查询（水位 lastFeedbackId 的配套；不走 HTTP）──

  /** id 水位之后的全部 feedback（跨 targetKind——蒸馏要全部新反馈）。 */
  listFeedbackSince(lastId: number): FeedbackRow[] {
    return this.db
      .select()
      .from(feedback)
      .where(gt(feedback.id, lastId))
      .orderBy(feedback.id)
      .all();
  }

  /** feedback 全表最大 id（水位推进兜底：无新行时也校准）。 */
  maxFeedbackId(): number {
    const r = this.db.select({ max: sql<number>`max(${feedback.id})` }).from(feedback).get();
    return r?.max ?? 0;
  }

  /** feedback 挂载目标反查所属会话（权限锚/蒸馏重入队共用口径；#34 审查 Std-4 归一）。整行返（canAccessConversation 要 userId）。 */
  conversationOfFeedbackTarget(kind: string, targetId: string): ConversationRow | null {
    let convId: string | null = null;
    if (kind === "message") convId = this.conversationIdOfMessage(targetId);
    else if (kind === "workflow_run") convId = this.conversationIdOfRun(targetId);
    else if (kind === "chat") convId = targetId;
    if (!convId) return null;
    const conv = this.db.select().from(conversations)
      .where(eq(conversations.id, convId)).get();
    return (conv as ConversationRow | undefined) ?? null;
  }

  /** message 级 feedback 反查会话（targetId=message id → conversationId）。 */
  conversationIdOfMessage(messageId: string): string | null {
    const r = this.db
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.id, Number(messageId)))
      .get();
    return r?.conversationId ?? null;
  }

  /** run 级 feedback 反查会话（workflow_runs.runId → conversationId）。 */
  conversationIdOfRun(runId: string): string | null {
    const r = this.db
      .select({ conversationId: workflowRuns.conversationId })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, runId))
      .get();
    return r?.conversationId ?? null;
  }
}