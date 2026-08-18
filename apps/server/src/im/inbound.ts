// IM 入站文本回流（spec #49 决策 2/4/5；T2 #51）：平台无关纯逻辑——身份解析 → 查用户 pending ask → 零切换/条件复用。
// 出站渲染是下游（T3 #52）；本模块只定义「回流」这一半：入站文本 → 世界。
//
// 决策对齐：
// - 无 pending → 静默丢弃（不起轮、不落库、不进历史、不推帧）——"无卡即弃"。
// - 有 pending ask 卡 → 按其 conversation_id 定位会话 → 复用 POST /messages 同款内联段
//   （appendMessage + publish(user_message) + enqueueHttpTurn(runTurn)）——与 Web 打字回答**完全同一条 turn**，
//   判答注入、工具引导、CAS 收口全部复用既有；IM 中间只夹了一层 LLM 归一化（pi 判答本来就做这个）。
// - approval/task 卡不放行文本回流（决策 5）：listPendingAskForUser 只查 kind=ask，文本命中审批/任务卡 → 丢弃。
//     （确定性动作只在确定性通道：Web/App 点卡。）
// - 响应只处理一次 = 域表 CAS（余者幂等），非投递层保证。
import type { RunDeps } from "../runs";
import type { Frame } from "../chat/eventbus";
import { runTurn } from "../chat/turn";
import { ConversationQueues } from "../chat/queue";

export interface ImInboundInput {
  imUserId: string;
  platform: string;
  text: string;
}

export type ImInboundStatus = "discarded" | "busy" | "processed";

export interface ImInboundResult {
  status: ImInboundStatus;
  conversationId?: string; // 命中的 pending 卡所属会话（processed 才有意义）
  questionId?: number;     // 命中的 pending ask 卡
  messageId?: number;      // 落库的 IM 文本消息 id（busy 双保险路径也可能已落）
  reply?: string;          // 处理结果确认文本（回发 IM 平台；取自 turn 输出/已答确认/简报）
}

/** 纯逻辑入口（平台无关）：IM 用户文本 → 回流处理。调用方（IM 平台 webhook）负责鉴权通道本身。 */
export async function handleImInbound(deps: RunDeps, input: ImInboundInput): Promise<ImInboundResult> {
  // 1. 身份解析（幂等；未绑定 → 丢弃）
  const user = deps.imStore?.resolve(input.imUserId, input.platform);
  if (!user) return { status: "discarded" };

  // 2. 查该用户所有活跃会话中**最新** pending ask 卡。无 → 丢弃（含 approval/task——决策 5 天生排除）。
  const q = deps.store.listPendingAskForUser(user.userId);
  if (!q) return { status: "discarded" };

  // 3. 按其 conversation_id 定位会话 → 复用 POST /messages 同款内联段。
  const convId = q.conversationId;
  const queues = deps.conversationQueues ?? new ConversationQueues();
  if (!queues.wouldAcceptHttpTurn(convId)) return { status: "busy", conversationId: convId }; // 429 语义（不入队前不落库，同 POST 路由）

  const messageId = deps.store.appendMessage({ conversationId: convId, role: "user", content: input.text });
  deps.store.touchConversation(convId);
  deps.eventBus?.publish(convId, { type: "user_message", id: messageId, content: input.text }); // 无 cardAnswered（本轮是真 LLM 轮）

  const ok = queues.enqueueHttpTurn(convId, (signal) => {
    const send = (fr: Frame) => deps.eventBus?.publish(convId, fr);
    return runTurn(deps, convId, input.text, send, signal);
  });
  if (!ok) {
    // wouldAccept 已通过仍失败（双保险）：消息已落 → error 帧提示（对齐 POST 路由的同段尾）
    deps.eventBus?.publish(convId, { type: "error", message: "conversation busy (queue full)" });
    return { status: "busy", conversationId: convId, messageId };
  }

  // 4. 等本轮 turn 结束（含判答 → resume_workflow/answer_question → CAS 落卡 → hitl_answered 广播，既有链路）。
  //    回发文本 = 会话最新一条 assistant 消息（turn 输出/收口后简报/已答确认）。
  await queues.drained(convId);
  const msgs = deps.store.listMessages(convId);
  const last = [...msgs].reverse().find((m) => m.role === "assistant");
  return { status: "processed", conversationId: convId, questionId: q.id, messageId, reply: last?.content ?? "已处理" };
}