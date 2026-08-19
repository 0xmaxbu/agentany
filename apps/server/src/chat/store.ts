// ChatStore（ADR-0030）：会话 + 消息持久化（chat 切片① ADR-0009）。
// deleteConversation 按 subject=会话归属：admin 硬删的四表级联是会话应用约束（一个类知道跨表级联不构成泄漏）。
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversations, hitlQuestions, messages, workflowRuns } from "../db/schema";
import { J, P, now } from "../db-utils";

export interface ConversationRow {
  id: string;
  workspaceId: string; // ADR-0018：会话挂 workspace
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

export class ChatStore {
  constructor(private db: BunSQLiteDatabase<any>) {}

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

  /** 会话活跃触达（#20）：updatedAt = 列表排序锚。no-op 安全。 */
  touchConversation(id: string): void {
    this.db.update(conversations).set({ updatedAt: now() }).where(eq(conversations.id, id)).run();
  }

  /** #命名：改 title（只改这一列）。 */
  renameConversation(id: string, title: string): void {
    this.db.update(conversations).set({ title }).where(eq(conversations.id, id)).run();
  }

  /** 创建者的会话列表（#20/f2）。updatedAt 倒序（id 破并列）。archived 反向过滤；分页可选。 */
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

  /** #21/ADR-0020 归档（幂等：已归档不动时间戳）。 */
  archiveConversation(id: string): ConversationRow | undefined {
    const conv = this.getConversation(id);
    if (!conv) return undefined;
    if (conv.archivedAt) return conv;
    const archivedAt = now();
    this.db.update(conversations).set({ archivedAt }).where(eq(conversations.id, id)).run();
    return { ...conv, archivedAt };
  }

  /** #21/ADR-0020 恢复（幂等：未归档 no-op）。 */
  restoreConversation(id: string): ConversationRow | undefined {
    const conv = this.getConversation(id);
    if (!conv) return undefined;
    if (!conv.archivedAt) return conv;
    this.db.update(conversations).set({ archivedAt: null }).where(eq(conversations.id, id)).run();
    return { ...conv, archivedAt: null };
  }

  /**
   * #21/ADR-0020 硬删（admin-only，全链清理，单事务）：conversations/messages/hitl_questions 行删；
   * workflow_runs.conversationId 置空解绑（run 属 workspace 资产非会话子资产，ADR-0018）。
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
}