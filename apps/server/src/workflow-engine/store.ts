// Drizzle 版 WorkflowStore（替 spike-b 裸 bun:sqlite；方法同 spike-b）。
// 这是引擎里唯一耦合 db 的文件；runner 只接收本类实例、不 import db。
import { and, desc, eq, gt, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
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
  // ADR-0025（#41）：terminal 简报——brief 与终态同事务写；briefMessageId 发信后回填（对账幂等锚）
  brief: string | null;
  briefMessageId: number | null;
}

export interface FeedbackRow {
  id: number;
  targetKind: string;
  targetId: string;
  text: string;
  rating: number | null;
  authorId: string | null; // #34 审查 Spec-4：作者（回显按人过滤）
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
  kind: "ask" | "approval" | "task"; // #16 ask | #18 approval | #28 task（任务卡）
  workflowId: string | null; // #18 approval：待审批工作流（ask 卡为空）
  input: unknown; // #18 approval：待审批 input（反序列化；approve 后用它 createRun）
  prompt: string;
  options: unknown; // 反序列化 string[]（labels）
  values: unknown; // ADR-0025（#46）：反序列化 AskOption[] = 显式 {label,value} 快照（ask 强制卡）
  context: string | undefined; // ADR-0025 决策 5（code-review F4）：决策辅助 markdown（从 input 提取下行；前端渲染归后续）
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

  /** 会话的 run 列表（#53/T4：run 卡刷新恢复）——域表直读，createdAt 倒序（最新在前）。无 run → []。 */
  listRunsForConversation(conversationId: string): RunRow[] {
    const rows = this.db.select().from(workflowRuns)
      .where(eq(workflowRuns.conversationId, conversationId))
      .orderBy(desc(workflowRuns.createdAt))
      .all();
    return rows.map((r) => ({ ...r, status: r.status as RunStatus, input: P(r.input) }));
  }

  /** #53/T4：会话 run 列表 + 每 run 的 log 步骤收敛（code-review：GET /runs 原是 route 内逐 run getLog 的 N+1——
   *   收敛下沉 store，log **一次批取**）。步骤 status = 每步最新态（append-only：running→completed 覆盖）；
   *   步骤序 = 首现 seq 序（logs 按 seq 升序，Map.set 首次命中键保留序）。 */
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

  // ── ADR-0025（#41/T1）：终态零 LLM 简报 ──

  /**
   * 终态 + brief + 简报消息 + briefMessageId 回填 + 会话 touch **同一 SQLite 事务**（崩溃封堵决策 3）。
   * code-review P4 修复：回填原是事务外第二条语句——崩在两写之间（消息已落、id 未回填），重启 reconcile
   * 会再插一条重复简报；现并入同事务，窗口归零。幂等 guard：briefMessageId 已非空 → 全程 no-op、返已有 id。
   * 消息只写有会话的 run（conversationId 非空 + content 非空）；返消息 id（未发 → 0）。
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

  /** ADR-0025 决策 6（#46/T3）：挂起强制卡——suspended 重确认 + 插 ask 卡(kind=ask, values=快照) **同一事务**
   *   （挂起落库与卡片同现，崩溃零窗口）。返 questionId。 */
  suspendWithAskCard(p: {
    runId: string;
    conversationId: string;
    prompt: string;
    options: unknown; // labels string[]
    values: unknown; // AskOption[] 快照（显式 {label,value}）
    resumeSchema?: unknown;
    input?: unknown; // ask 卡暂挂 context 等决策素材（前端零改造，留待卡渲染）
  }): number {
    let qid = 0;
    this.db.transaction((tx) => {
      tx.update(workflowRuns).set({ status: "suspended", updatedAt: now() }).where(eq(workflowRuns.runId, p.runId)).run();
      qid = this.insertQuestion(tx, {
        conversationId: p.conversationId, runId: p.runId, kind: "ask", input: J(p.input),
        prompt: p.prompt, options: J(p.options) as string, values: J(p.values),
        resumeSchema: J(p.resumeSchema), multiple: 0, status: "pending", createdAt: now(),
      });
    });
    return qid;
  }

  reset(): void {
    this.db.delete(workflowRunLog).run();
    this.db.delete(workflowRuns).run();
  }

  // ticket #14 + ADR-0025 决策 3（#45/T2）：boot sweep——DB 里仍 running 的 run 标 failed
// （重启=进程没在跑了），**同步写** brief=「异常终止（进程重启）」——对账补发文案诚实（sweep 先于 reconcile）。
  markRunningAsFailed(): number {
    const r = this.db
      .update(workflowRuns)
      .set({ status: "failed", brief: "异常终止（进程重启）", updatedAt: now() })
      .where(eq(workflowRuns.status, "running"))
      .run();
    return (r as any).changes ?? 0;
  }

  /** ADR-0025 决策 3（#45/T2）：终态（completed/failed）且简报未发（brief_message_id NULL）且 brief 已写的 run——
   *  对账补发扫描键。**排除已删会话**（conversationId 已解绑/置空）。 */
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
    return rows.map((r) => ({ ...r, status: r.status as RunStatus, input: P(r.input) }));
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

  /** feedback 挂载目标反查所属会话（权限锚/蒸馏重入队共用口径；#34 审查 Std-4 归一）。 */
  conversationOfFeedbackTarget(kind: string, targetId: string): ConversationRow | null {
    let convId: string | null = null;
    if (kind === "message") convId = this.conversationIdOfMessage(targetId);
    else if (kind === "workflow_run") convId = this.conversationIdOfRun(targetId);
    else if (kind === "chat") convId = targetId;
    return convId ? (this.getConversation(convId) ?? null) : null;
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

  /** #命名：改 title（只改这一列——重命名不动排序锚 updatedAt）。不存在 no-op。 */
  renameConversation(id: string, title: string): void {
    this.db.update(conversations).set({ title }).where(eq(conversations.id, id)).run();
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

  /** hitl_questions 插入收敛点（code-review S2）：createQuestion（裸库）与 suspendWithAskCard（事务内）
   *  共用同一字段集——两处 10 行 insert 曾近乎全同，字段增删只改这里。
   *  fail-fast：插入失败不静默返 0（否则 ask_user/审批门会渲染 id=0 假卡，点批准必 404）。 */
  private insertQuestion(
    exec: BunSQLiteDatabase | Parameters<Parameters<BunSQLiteDatabase["transaction"]>[0]>[0],
    v: typeof hitlQuestions.$inferInsert,
  ): number {
    const r = (exec as BunSQLiteDatabase) // tx 与库的 insert 同构（drizzle 事务泛型不便于精确表达，单点 cast）
      .insert(hitlQuestions)
      .values(v)
      .returning({ id: hitlQuestions.id })
      .get();
    if (!r) throw new Error(`insertQuestion: insert returned no row (prompt=${String(v.prompt).slice(0, 40)})`);
    return r.id;
  }

  createQuestion(p: {
    conversationId: string; runId?: string | null; prompt: string; options: unknown;
    values?: unknown; resumeSchema?: unknown; multiple?: boolean;
    kind?: "ask" | "approval" | "task"; workflowId?: string; input?: unknown; decidedBy?: string;
  }): number {
    return this.insertQuestion(this.db, {
      conversationId: p.conversationId, runId: p.runId ?? null, kind: p.kind ?? "ask",
      workflowId: p.workflowId ?? null, input: J(p.input), prompt: p.prompt,
      options: J(p.options) as string, values: J(p.values), resumeSchema: J(p.resumeSchema),
      multiple: p.multiple ? 1 : 0, status: "pending", decidedBy: p.decidedBy ?? null, createdAt: now(),
    });
  }

  /** IM 回流（spec #49 决策 2/5/T2 #51）：该用户全部活跃会话中**最新** pending ask 卡。
   *   kind=ask 硬过滤——approval/task 卡禁用文本回流（决策 5：确定性动作只在确定性通道）。
   *   无 → undefined（入站文本随即丢弃）。 */
  listPendingAskForUser(userId: string): QuestionRow | undefined {
    const rows = this.db.select()
      .from(hitlQuestions)
      .innerJoin(conversations, eq(hitlQuestions.conversationId, conversations.id))
      .where(and(
        eq(conversations.userId, userId),
        isNull(conversations.archivedAt),
        eq(hitlQuestions.kind, "ask"),
        eq(hitlQuestions.status, "pending"),
      ))
      .orderBy(desc(hitlQuestions.id))
      .limit(1)
      .all();
    const r = rows[0]?.hitl_questions;
    return r ? this.toQuestionRow(r as any) : undefined;
  }

  listQuestions(conversationId: string, opts?: { includeAnswered?: boolean; kind?: "ask" | "approval" | "task" }): QuestionRow[] {
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

  /** 自主 ask 卡收口（ADR-0025 决策 10 修订）：回答即 solved——answer=点选文本（dispatch）或 pi 归一化答案（answer_question）。
   *  CAS pending→answered（已答返 undefined 行状由调用方幂等处理）。 */
  markQuestionAnswered(id: number, answer: unknown): QuestionRow | undefined {
    const q = this.getQuestion(id);
    if (!q || q.status !== "pending") return undefined;
    this.db.update(hitlQuestions)
      .set({ status: "answered", answer: J(answer), answeredAt: now() })
      .where(and(eq(hitlQuestions.id, id), eq(hitlQuestions.status, "pending")))
      .run();
    return this.getQuestion(id);
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

  /** #28：任务卡落决（confirm/cancel）。CAS（WHERE pending）防并发双击；非 pending → undefined。 */
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

  private toQuestionRow(r: any): QuestionRow {
    const input = P(r.input);
    // F4（code-review）：ask 卡决策辅助 context 从 input 提取（suspendWithAskCard 以 {context} 暂挂）。
    const context = !!input && typeof input === "object" && typeof (input as { context?: unknown }).context === "string"
      ? (input as { context: string }).context
      : undefined;
    return {
      id: r.id, conversationId: r.conversationId, runId: r.runId, kind: r.kind ?? "ask",
      workflowId: r.workflowId, input, context, prompt: r.prompt,
      options: P(r.options), values: P(r.values), resumeSchema: P(r.resumeSchema), multiple: r.multiple,
      status: r.status as "pending" | "answered", answer: P(r.answer), decidedBy: r.decidedBy,
      createdAt: r.createdAt, answeredAt: r.answeredAt,
    };
  }
}
