// 「内联 turn」公共段（code-review：POST /messages 与 IM 回流曾逐行复刻六步，已漂移——抽单点收敛）。
// 谁消费输入谁起轮（ADR-0025 决策 9）：appendMessage(user) + touch + publish(user_message) + enqueueHttpTurn(runTurn)。
// 429 预检由调用方先行（route 返 429 / inbound 返 busy，各自口吻不同），本函数假定队列已可入——
// 只保留「入队失败」的双保险 error 帧（入队前调度窗口仍在）。
import type { RunDeps } from "../runs";
import type { EventBus, Frame } from "./eventbus";
import type { ConversationQueues } from "./queue";
import { runTurn } from "./turn";

/**
 * 落用户消息 + 起内联轮。skipTurn（程序化卡收口/纯 dispatch）→ 消息照落但不起 LLM 轮，
 * user_message 帧带 cardAnswered 旗标（前端免 LLM 占位）。
 * eventBus **调用方显式传**：route 传共享闭包 bus（`deps.eventBus ?? new EventBus()`——fullDeps 等未 wire 时
 * SSE /stream 订阅在本地 bus 上，deps.eventBus 直接发布会进黑洞）；inbound 传 deps.eventBus（无非 wire 场景）。
 * 返回 { messageId, accepted }（accepted=false 表示入队双保险失败，消息已落库、error 帧已发）。
 */
export function startInlineTurn(
  deps: RunDeps,
  queues: ConversationQueues,
  eventBus: EventBus | undefined,
  convId: string,
  content: string,
  opts?: { skipTurn?: boolean },
): { messageId: number; accepted: boolean } {
  const messageId = deps.store.appendMessage({ conversationId: convId, role: "user", content });
  deps.store.touchConversation(convId); // updatedAt = 列表排序锚（#20）
  eventBus?.publish(convId, { type: "user_message", id: messageId, content, ...(opts?.skipTurn ? { cardAnswered: true } : {}) });
  if (opts?.skipTurn) return { messageId, accepted: true }; // 确定性收口轮不判答
  const accepted = queues.enqueueHttpTurn(convId, (signal) => {
    const send = (fr: Frame) => eventBus?.publish(convId, fr);
    return runTurn(deps, convId, content, send, signal);
  });
  if (!accepted) eventBus?.publish(convId, { type: "error", message: "conversation busy (queue full)" });
  return { messageId, accepted };
}