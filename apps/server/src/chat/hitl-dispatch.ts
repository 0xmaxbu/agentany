// 统一卡应答 dispatch（#28 重构，收编 #18 审批门 + #28 任务卡确认 + #46/T5 ask 卡三态）：
// 消息绑定 questionId（POST /messages inReplyTo）→ 按 kind 的 handler 确定性执行。
// 漂移根除：确认信号不再经 LLM 判答（ask 卡打字回答仍走老判答路——那是语义归一化功能）。
// ADR-0025 决策 10（#47/T5）：跳轮判定一句话——**答案的消费者是引擎（resume 副作用）则跳轮，
// 是 pi（对话语义）则不跳**；卡=确定性收口，自由文本=LLM 归一化。
// 落卡形态整体删除：旧 hitl-dispatch 的 deterministicResumeData===undefined → markTaskCardDecided 分支
// 已废（answered 后注入消失 + pi 不读 messages → resume 无人职守）；强制卡恒有快照、自主卡滑 LLM。
import type { RunDeps } from "../runs";
import type { QuestionRow } from "../hitl/store"; // ADR-0030：卡类型随 hitl 域文件带
import type { ResumeOutcome } from "../workflow-engine/runner";
import { SystemTaskProtected } from "../scheduled-tasks/store";
import type { Frame } from "./eventbus";
import { validateCronAndFirstFire } from "../scheduled-tasks/cron";

export interface DispatchResult {
  handled: boolean; // true=卡被确定性收口；false=无卡/不可处理（消息照常走对话流）
  error?: string; // handled 内部副作用失败（调用方记日志，不阻塞消息）
  /** #47/T5：程序化轮旗标（T6 路由据此跳过 LLM turn）。true=已/可确定性收口（含已答双击幂等 ack），
   *  不另起 LLM 轮，免 429；undefined=滑 LLM 轮（答案消费者是 pi）。 */
  skipTurn?: boolean;
}

/**
 * 处理一条带 inReplyTo 的消息对卡的应答。安全：卡必须在「当前会话」（消息所在 conv）；
 * task/approval 的确认权=卡主（conv 创建者）；已 answered 的卡（双击）→ 幂等 ack（skipTurn，
 * 不重复执行、不二次起轮——ADR-0025 决策 10）。
 */
export async function dispatchCardAnswer(
  deps: RunDeps,
  conversationId: string,
  questionId: number,
  content: string,
  userId: string,
): Promise<DispatchResult> {
  const q = deps.hitlStore.getQuestion(questionId);
  if (!q || q.conversationId !== conversationId) return { handled: false };
  if (q.status !== "pending") return { handled: false, skipTurn: true }; // 已答双击：消息落库、不二次派发/起轮
  const conv = deps.chatStore.getConversation(conversationId);
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
    return { handled: true, skipTurn: true, error: (e as Error).message };
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
    deps.hitlStore.markTaskCardDecided(q.id, { decision: "cancel", message: content });
    publish({ type: "hitl_answered", questionId: q.id, kind: "task", answer: { decision: "cancel" } });
    return { handled: true, skipTurn: true };
  }

  if (input.update) {
    const { taskId, patch } = input.update;
    let row;
    try {
      row = deps.taskStore!.updateTask(taskId, patch);
    } catch (e) {
      if (e instanceof SystemTaskProtected) return { handled: true, skipTurn: true, error: "system task protected" };
      throw e;
    }
    if (!row) {
      deps.hitlStore.markTaskCardDecided(q.id, { decision: "cancel", message: "task no longer exists" });
      publish({ type: "hitl_answered", questionId: q.id, kind: "task", answer: { decision: "cancel" } });
      return { handled: true, skipTurn: true, error: "task no longer exists" };
    }
    if (patch.cron) deps.taskStore!.recomputeNextFire(taskId);
    deps.hitlStore.markTaskCardDecided(q.id, { decision: "confirm", taskId });
    publish({ type: "hitl_answered", questionId: q.id, kind: "task", answer: { decision: "confirm", taskId } });
    return { handled: true, skipTurn: true };
  }

  if (!input.displayName || !input.cron || !input.prompt) return { handled: true, skipTurn: true, error: "card payload incomplete" };
  const conv = deps.chatStore.getConversation(q.conversationId)!;
  const task = deps.taskStore!.createWorkspaceTask({
    displayName: input.displayName, cron: input.cron, prompt: input.prompt,
    workspaceId: conv.workspaceId, creatorId: conv.userId,
    firstFireAt: validateCronAndFirstFire(input.cron),
  });
  deps.hitlStore.markTaskCardDecided(q.id, { decision: "confirm", taskId: task.id });
  publish({ type: "hitl_answered", questionId: q.id, kind: "task", answer: { decision: "confirm", taskId: task.id } });
  return { handled: true, skipTurn: true };
};

// ── approval（#18 收编）：options[0]=批准 options[1]=拒绝（既有契约：index 对位）──
const approvalHandler: KindHandler = async ({ deps, q, content, userId, publish }) => {
  const idx = optionIndex(q.options as string[], content);
  if (idx < 0) return { handled: false };
  if (idx === 1) { // deny
    const row = deps.hitlStore.markApprovalDecided(q.id, { decision: "deny" }, userId);
    if (!row) return { handled: false }; // CAS 失败（并发已决）
    publish({ type: "hitl_answered", questionId: q.id, kind: "approval", answer: { decision: "deny" } });
    return { handled: true, skipTurn: true };
  }
  // approve：CAS 占位 → createRun（approved:true 跳 policy）→ 回填；失败回滚可重试
  const claimed = deps.hitlStore.markApprovalDecided(q.id, { decision: "approve" }, userId);
  if (!claimed) return { handled: false };
  if (!deps.runLifecycle) {
    deps.hitlStore.reopenApproval(q.id);
    return { handled: true, skipTurn: true, error: "run lifecycle unavailable" };
  }
  let runId: string;
  try {
    const outcome = await deps.runLifecycle.start({
      conversationId: q.conversationId, workflowId: q.workflowId!, input: q.input ?? {}, approved: true,
    });
    if (outcome.status !== "running") {
      deps.hitlStore.reopenApproval(q.id);
      return { handled: true, skipTurn: true, error: `unexpected start outcome: ${outcome.status}` };
    }
    runId = outcome.runId;
  } catch (e) {
    deps.hitlStore.reopenApproval(q.id);
    return { handled: true, skipTurn: true, error: `failed to start: ${(e as Error).message}` };
  }
  deps.hitlStore.backfillApprovalRunId(q.id, runId);
  publish({ type: "hitl_answered", questionId: q.id, kind: "approval", runId, answer: { decision: "approve" } });
  return { handled: true, skipTurn: true };
};

// ── ask（ADR-0025 决策 7/10，#47/T5 + 决策 10 修订）：run 绑定卡 + 点击命中 values 快照 → 程序化 resume（零 LLM）；
//   自主卡点选 → 确定性收口（answer=选项文本）但**不跳轮**（答案消费者是 pi——对话继续）；
//   快照缺值 / 打字 → slide 滑 LLM 轮（run 绑定：pi 归一化+resume；自主：pi 归一化+answer_question）──
const askHandler: KindHandler = async ({ deps, q, content, publish }) => {
  const idx = optionIndex(q.options as string[], content);
  if (idx < 0) return { handled: false }; // 打字（非选项文本）→ 滑 LLM 轮（pi 归一化，答案消费者是 pi）
  if (!q.runId) {
    // 自主卡（决策 10 修订）：回答即 solved——记录答案上卡，问题不再悬置；pi 轮照跑（注入引导 answer_question/续答）
    const row = deps.hitlStore.markQuestionAnswered(q.id, content);
    if (row) publish({ type: "hitl_answered", questionId: q.id, answer: content, kind: "ask" });
    return { handled: true }; // skipTurn 不设 → LLM 轮照常入队（429 语义同普通消息）
  }
  const resumeData = deterministicResumeData(q, idx); // values 快照查表（旧 enum 对位已退役）
  if (resumeData === undefined) return { handled: false }; // 无快照不可映射 → slide（卡保 pending）
  let outcome: ResumeOutcome;
  try {
    outcome = await deps.runLifecycle!.resume(q.runId, resumeData);
  } catch (e) {
    return { handled: true, skipTurn: true, error: `resume failed: ${(e as Error).message}` };
  }
  if ("rejected" in outcome) return { handled: true, skipTurn: true, error: `resume rejected: ${outcome.error}` }; // 保持 pending 供重试
  if ("idempotent" in outcome) return { handled: true, skipTurn: true }; // 重复点击/已答：不二次起轮（幂等 ack）
  // clean（ADR-0025 决策 11：即时 running，续跑 detached）→ 答案已确定性派发：markAnswered + hitl_answered
  const row = deps.hitlStore.markPendingAnsweredByRun(q.runId, resumeData);
  if (row) publish({ type: "hitl_answered", questionId: q.id, answer: resumeData, kind: "ask", runId: q.runId });
  return { handled: true, skipTurn: true };
};

/** 确定性映射（决策 5/6，#47/T5）：显式 {label,value} **快照查表**（value 即 resumeData）。
 *  旧「enum 对位」回落（ADR-0022 决策 4）已随旧手写卡形态退役——产品未发布零兼容负担，
 *  run 绑定卡恒由引擎同事务直建、恒带 values 快照。无快照 → undefined（滑 LLM 轮，pi 归一化）。 */
export function deterministicResumeData(q: QuestionRow, idx: number): unknown | undefined {
  if (Array.isArray(q.values) && q.values.length > idx) {
    const v = (q.values[idx] as { value?: unknown }).value;
    if (v !== undefined) return v; // label→value 命中（快照；卡自包含，重启/改 workflow 定义不失效）
  }
  return undefined;
}

const HANDLERS: Record<string, KindHandler> = {
  task: taskHandler,
  approval: approvalHandler,
  ask: askHandler,
};
