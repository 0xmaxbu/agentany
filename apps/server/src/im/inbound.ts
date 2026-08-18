// IM 入站文本回流（spec #49 决策 2/4/5 + #55/T6）：平台无关纯逻辑——身份解析 → 扫全部 pending ask 卡三分支：
//   0 张 → 静默丢弃；最新 pending 是 approval/task → 回「去 Web/App 点卡」提示（决策 5，文本不放行确定性通道）。
//   1 张 → 按其 conversation_id 定位会话 → 复用 POST /messages 同款内联段（judgeAskCard）——与 Web 打字完全同一条 turn。
//   >1 张 → 文本归属不明：choice_needed（缓存文本 + 发选择卡由调用方渲染），点选后回 judgeAskCard（T6）。
// - 响应只处理一次 = 域表 CAS（余者幂等）＋队列 FIFO 串行（同一会话同时只一条 turn），非投递层保证。
import type { RunDeps } from "../runs";
import type { QuestionRow } from "../workflow-engine/store";
import { ConversationQueues } from "../chat/queue";
import { startInlineTurn } from "../chat/inline-turn";
import type { PendingTextCache } from "./pending-text";

export interface ImInboundInput {
  imUserId: string;
  platform: string;
  text: string;
}

export type ImInboundStatus = "discarded" | "busy" | "processed" | "choice_needed";

export interface ImInboundResult {
  status: ImInboundStatus;
  conversationId?: string; // 命中的 pending 卡所属会话（processed 才有意义）
  questionId?: number;     // 命中的 pending ask 卡
  messageId?: number;      // 落库的 IM 文本消息 id（busy 双保险路径也可能已落）
  reply?: string;          // 处理结果确认文本（回发 IM 平台；取自 turn 输出/已答确认/简报）
  candidates?: { questionId: number; prompt: string }[]; // choice_needed：待选卡清单（选择卡采用）
}

/** 纯逻辑入口（平台无关）：IM 用户文本 → 回流处理。调用方（IM 平台 webhook）负责鉴权通道本身。 */
export async function handleImInbound(deps: RunDeps, input: ImInboundInput, pending?: PendingTextCache): Promise<ImInboundResult> {
  // 1. 身份解析（幂等；未绑定 → 丢弃）
  const user = deps.imStore?.resolve(input.imUserId, input.platform);
  if (!user) return { status: "discarded" };

  // 2. 扫该用户全部活跃会话的 pending 卡（T6 口径：不限最新——文本可应答对象是 ask 卡，kind 拦截在决策层）
  const all = deps.store.listPendingCardsForUser(user.userId);

  // 3. 三分支：0 / 1 / >1 张 ask 卡
  const askCards = all.filter((q) => q.kind === "ask");
  if (askCards.length > 1) {
    // 多条 → 文本归属不明：缓存待确认文本（覆盖；TTL 过期清理），调用方发选择卡
    pending?.set(input.imUserId, input.text);
    return { status: "choice_needed", candidates: askCards.map((q) => ({ questionId: q.id, prompt: q.prompt })) };
  }
  if (askCards.length === 1) {
    // 恰一张 → 直接判答（按该 ask 卡自己的 conversation_id 定位）
    return judgeAskCard(deps, askCards[0], input.text);
  }

  // 4. 0 张 ask：决策 5——最新 pending 是 approval/task → 文本不放行（确定性通道提示去 Web/App）
  const latest = all[all.length - 1]; // listPendingCardsForUser 按 id 升序 → 末尾 = 最新
  if (!latest) return { status: "discarded" }; // 无卡即弃（静默）
  if (latest.kind !== "ask") {
    const label = latest.kind === "approval" ? "审批卡" : "任务卡";
    return { status: "discarded", reply: `您有未处理的${label}，请在 Web/App 打开对应会话点卡处理` };
  }
  return { status: "discarded" }; // 防御：ask 但不在 askCards（不该发生）
}

/** 单张 ask 卡判答（handleImInbound 1 张分支 与 选择卡点选 共用）：定位会话 → 内联 turn（文本归一化 + CAS 收口）→ 回执。 */
export async function judgeAskCard(deps: RunDeps, q: QuestionRow, text: string): Promise<ImInboundResult> {
  const convId = q.conversationId;
  const queues = deps.conversationQueues ?? new ConversationQueues();
  if (!queues.wouldAcceptHttpTurn(convId)) return { status: "busy", conversationId: convId }; // 429 语义（不入队前不落库，同 POST 路由）
  // T6 消歧聚焦：判答只注入这一张 ask 卡（1 张分支本就唯一；选择卡点选后不撞其它卡）
  const { messageId, accepted } = startInlineTurn(deps, queues, deps.eventBus, convId, text, { focusQuestionId: q.id });
  if (!accepted) return { status: "busy", conversationId: convId, messageId }; // 双保险失败：消息已落 → error 帧已发
  await queues.drained(convId);
  const msgs = deps.store.listMessages(convId);
  const last = [...msgs].reverse().find((m) => m.role === "assistant");
  return { status: "processed", conversationId: convId, questionId: q.id, messageId, reply: last?.content ?? "已处理" };
}