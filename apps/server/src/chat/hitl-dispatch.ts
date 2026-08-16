// 统一卡应答 dispatch（#28 重构，收编 #18 审批门 + #28 任务卡确认）：
// 消息绑定 questionId（POST /messages inReplyTo）→ 按 kind 的 handler 确定性执行。
// 设计动机：专用确认路由（/approvals/:id/decide、/scheduled-tasks/confirm/:id）每卡型一套
// （路由+CAS+帧），第三种卡还得再抄——收敛为「一条消息通道 + kind handler 注册表」。
// 漂移根除：确认信号不再经 LLM 判答（ask 卡打字回答仍走老判答路——那是语义归一化功能）。
// 答案仍以普通消息落库（对话历史可见）；卡 answered 行的 answer 记确定性结果。
import type { RunDeps } from "../runs";
import type { QuestionRow } from "../workflow-engine/store";
import { SystemTaskProtected } from "../scheduled-tasks/store";
import type { Frame } from "./eventbus";
import { validateCronAndFirstFire } from "../scheduled-tasks/cron";

export interface DispatchResult {
  handled: boolean; // true=卡被确定性收口；false=无卡/不可处理（消息照常走对话流）
  error?: string; // handled 内部副作用失败（调用方记日志，不阻塞消息）
}

/**
 * 处理一条带 inReplyTo 的消息对卡的应答。幂等：卡非 pending → handled:false（不重复执行）。
 * 安全：卡必须在「当前会话」（消息所在 conv）；task/approval 的确认权=卡主（conv 创建者），
 * 消息路由的会话守卫已保证发送者可见该会话，但 admin 也能进会话——故再校验 conv.userId。
 */
export async function dispatchCardAnswer(
  deps: RunDeps,
  conversationId: string,
  questionId: number,
  content: string,
  userId: string,
): Promise<DispatchResult> {
  const q = deps.store.getQuestion(questionId);
  if (!q || q.conversationId !== conversationId || q.status !== "pending") return { handled: false };
  const conv = deps.store.getConversation(conversationId);
  if (!conv) return { handled: false };

  const publish = (frame: Frame) => deps.eventBus?.publish(conversationId, frame);
  const handler = HANDLERS[q.kind];
  if (!handler) return { handled: false }; // 未知卡型（ask 打字走老路也不带 inReplyTo）

  // task 卡=卡主自建自批（admin 也不代确认，ADR-0021）；approval 卡=会话可见的人类即可
  // （#18 审批人常是 admin——路由的会话守卫已挡外部，bridge 无消息端点 → pi 无自批路径）。
  if (q.kind === "task" && conv.userId !== userId) return { handled: false };

  try {
    return await handler({ deps, q, content, userId, convId: conversationId, publish });
  } catch (e) {
    return { handled: true, error: (e as Error).message };
  }
}

interface HandlerCtx {
  deps: RunDeps;
  q: QuestionRow;
  content: string; // 用户答案原文（选项文本）
  userId: string;
  convId: string;
  publish: (f: Frame) => void;
}

type KindHandler = (ctx: HandlerCtx) => Promise<DispatchResult>;

/** 选项匹配：content 命中卡上哪个选项（精确匹配；未命中 → -1）。 */
const optionIndex = (options: string[], content: string): number => options.findIndex((o) => o === content);

// ── task：确认（options[0]）建/改任务；取消（options[1]）不建。参数读卡上 input（零漂移）──
const taskHandler: KindHandler = async ({ deps, q, content, publish }) => {
  const idx = optionIndex(q.options as string[], content);
  if (idx < 0) return { handled: false }; // 不是卡上选项（用户改打字了）→ 走对话流让 pi 解释
  const confirm = idx === 0;
  const input = q.input as {
    displayName?: string; cron?: string; prompt?: string;
    update?: { taskId: string; patch: Record<string, string> };
  };

  if (!confirm) {
    deps.store.markTaskCardDecided(q.id, { decision: "cancel", message: content });
    publish({ type: "hitl_answered", questionId: q.id, kind: "task", answer: { decision: "cancel" } });
    return { handled: true };
  }

  if (input.update) {
    const { taskId, patch } = input.update;
    let row;
    try {
      row = deps.taskStore!.updateTask(taskId, patch);
    } catch (e) {
      if (e instanceof SystemTaskProtected) return { handled: true, error: "system task protected" };
      throw e;
    }
    if (!row) {
      deps.store.markTaskCardDecided(q.id, { decision: "cancel", message: "task no longer exists" });
      publish({ type: "hitl_answered", questionId: q.id, kind: "task", answer: { decision: "cancel" } });
      return { handled: true, error: "task no longer exists" };
    }
    if (patch.cron) deps.taskStore!.recomputeNextFire(taskId);
    deps.store.markTaskCardDecided(q.id, { decision: "confirm", taskId });
    publish({ type: "hitl_answered", questionId: q.id, kind: "task", answer: { decision: "confirm", taskId } });
    return { handled: true };
  }

  if (!input.displayName || !input.cron || !input.prompt) return { handled: true, error: "card payload incomplete" };
  const conv = deps.store.getConversation(q.conversationId)!;
  const task = deps.taskStore!.createWorkspaceTask({
    displayName: input.displayName, cron: input.cron, prompt: input.prompt,
    workspaceId: conv.workspaceId, creatorId: conv.userId,
    firstFireAt: validateCronAndFirstFire(input.cron),
  });
  deps.store.markTaskCardDecided(q.id, { decision: "confirm", taskId: task.id });
  publish({ type: "hitl_answered", questionId: q.id, kind: "task", answer: { decision: "confirm", taskId: task.id } });
  return { handled: true };
};

// ── approval（#18 收编）：options[0]=批准 options[1]=拒绝（既有契约：index 对位）──
const approvalHandler: KindHandler = async ({ deps, q, content, userId, publish }) => {
  const idx = optionIndex(q.options as string[], content);
  if (idx < 0) return { handled: false };
  if (idx === 1) { // deny
    const row = deps.store.markApprovalDecided(q.id, { decision: "deny" }, userId);
    if (!row) return { handled: false }; // CAS 失败（并发已决）
    publish({ type: "hitl_answered", questionId: q.id, kind: "approval", answer: { decision: "deny" } });
    return { handled: true };
  }
  // approve：CAS 占位 → createRun（approved:true 跳 policy）→ 回填；失败回滚可重试
  const claimed = deps.store.markApprovalDecided(q.id, { decision: "approve" }, userId);
  if (!claimed) return { handled: false };
  if (!deps.runRegistry) {
    deps.store.reopenApproval(q.id);
    return { handled: true, error: "run registry unavailable" };
  }
  let runId: string;
  try {
    const outcome = deps.runRegistry.start({
      conversationId: q.conversationId, workflowId: q.workflowId!, input: q.input ?? {}, approved: true,
    });
    if (outcome.status !== "running") {
      deps.store.reopenApproval(q.id);
      return { handled: true, error: `unexpected start outcome: ${outcome.status}` };
    }
    runId = outcome.runId;
  } catch (e) {
    deps.store.reopenApproval(q.id);
    return { handled: true, error: `failed to start: ${(e as Error).message}` };
  }
  deps.store.backfillApprovalRunId(q.id, runId);
  publish({ type: "hitl_answered", questionId: q.id, kind: "approval", runId, answer: { decision: "approve" } });
  return { handled: true };
};

// ── ask（工作流判答）：点选项=确定性；打字不带 inReplyTo 走老路（pi 归一化）──
// 约定（ADR-0022）：options 与 resumeSchema 顶层单 enum 属性按序对位（工作流作者按序给标签）；
// 非对位形（多属性/无 enum）→ 只 markAnswered(选项原文)，resume 留给 pi 下轮归一化。
const askHandler: KindHandler = async ({ deps, q, content, publish }) => {
  const idx = optionIndex(q.options as string[], content);
  if (idx < 0) return { handled: false };
  const resumeData = deterministicResumeData(q.resumeSchema, idx);
  if (resumeData === undefined) {
    // 复杂 schema：答案落卡（pi 注入看到 answered 卡 + 原文答案，归一化后 resume_workflow）
    const row = deps.store.markTaskCardDecided(q.id, content);
    if (!row) return { handled: false };
    publish({ type: "hitl_answered", questionId: q.id, answer: content });
    return { handled: true };
  }
  let outcome;
  try {
    outcome = await deps.runRegistry!.resume(q.runId!, resumeData);
  } catch (e) {
    return { handled: true, error: `resume failed: ${(e as Error).message}` };
  }
  if ("rejected" in outcome) return { handled: true, error: `resume rejected: ${outcome.error}` }; // 保持 pending 供重试
  if ("idempotent" in outcome) return { handled: true };
  const row = deps.store.markPendingAnsweredByRun(q.runId!, resumeData);
  if (row) publish({ type: "hitl_answered", questionId: row.id, answer: resumeData });
  return { handled: true };
};

/** 约定映射：手搓 schema（schema.ts 可序列化形：{_t:"object", shape:{prop:{_t:"enum", vals:[...]}}}）
 * 顶层恰一个 enum 属性、其余属性全 optional（resume 时可省略）→ { [prop]: vals[idx] }。
 * 否则 undefined（不可确定性映射，留给 pi 归一化）。 */
export function deterministicResumeData(resumeSchema: unknown, idx: number): unknown | undefined {
  if (!resumeSchema || typeof resumeSchema !== "object") return undefined;
  const s = resumeSchema as { _t?: string; shape?: Record<string, { _t?: string; vals?: unknown[] }> };
  if (s._t !== "object" || !s.shape) return undefined;
  const entries = Object.entries(s.shape);
  const enums = entries.filter(([, def]) => def._t === "enum" && Array.isArray(def.vals));
  if (enums.length !== 1) return undefined;
  if (!entries.every(([, def]) => def._t === "enum" || def._t === "optional")) return undefined;
  const [prop, def] = enums[0];
  if ((def.vals as unknown[]).length <= idx) return undefined;
  return { [prop]: (def.vals as unknown[])[idx] };
}

const HANDLERS: Record<string, KindHandler> = {
  task: taskHandler,
  approval: approvalHandler,
  ask: askHandler,
};
