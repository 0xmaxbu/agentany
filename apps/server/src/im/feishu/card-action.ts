// 飞书卡按钮回调处理（spec #55/T4 #59）：card.action.trigger → 映射 value → 复用 hitl-dispatch（CAS 收口）
// → 组装回调响应（更新卡 + toast）。应答经长连接 ack 的 data 字段回传（data=base64(JSON{rsp})，node SDK 同款）。
//
// 回调 value = {questionId, value: 选项label}（T3 决策）。点击者 = operator.open_id（绑定的用户身份）→
// dispatchCardAnswer 以该 userId 落定（approval 记录决策人；task 卡主守卫）。
//
// 幂等：已答/并发 → dispatch 返回 skipTurn → 响应「该卡已被处理」卡 + toast（不二次执行——CAS 收口）。
// 响应格式（v1 契约，live smoke 最终验收）：{ toast: {type, content}, card: <已答卡 2.0> }。
import type { RunDeps } from "../../runs";
import type { QuestionRow } from "../../hitl/store"; // ADR-0030：卡类型随 hitl 域文件带
import { dispatchCardAnswer } from "../../chat/hitl-dispatch";
import { cardInputOf, renderAnsweredCard } from "../card";
import { judgeAskCard } from "../inbound";
import { larkEventOf, larkOperatorOpenId } from "./events";
import type { PendingTextCache } from "../pending-text";

export interface CardActionInput {
  questionId: number;
  value: string; // 选项 label（按钮 content）
  openId: string; // 点击者 open_id
}

/** card.action.trigger 事件 → {questionId, value, openId}；value 缺/类型错/无操作者 → null。纯函数单测直测。 */
export function mapCardAction(payload: unknown): CardActionInput | null {
  const value = (larkEventOf(payload) as { action?: { value?: unknown } } | undefined)?.action?.value as { questionId?: unknown; value?: unknown } | null | undefined;
  if (!value || typeof value.questionId !== "number" || typeof value.value !== "string") return null;
  const openId = larkOperatorOpenId(payload);
  if (!openId) return null;
  return { questionId: value.questionId, value: value.value, openId };
}

/** 选择卡点击（T6）：value = { selectQuestionId } → {questionId, openId}；缺/类型错 → null。 */
export function mapSelectAction(payload: unknown): { questionId: number; openId: string } | null {
  const value = (larkEventOf(payload) as { action?: { value?: unknown } } | undefined)?.action?.value as { selectQuestionId?: unknown } | null | undefined;
  if (!value || typeof value.selectQuestionId !== "number") return null;
  const openId = larkOperatorOpenId(payload);
  if (!openId) return null;
  return { questionId: value.selectQuestionId, openId };
}

const SUCCESS_MSG: Record<string, string> = { ask: "已处理", approval: "已审批", task: "已确认" };

/** 卡回调响应：toast + 已答态卡（更新原卡）。card 须带 raw 包装（飞书回调响应契约：card.type="raw" + data=卡 JSON）。
 *  live smoke 修复：裸卡 JSON 会被飞书判 200673「返回了错误的卡片」→ 客户端 toast「处理出错」。 */
export function answeredCardRsp(q: QuestionRow, toastText: string, toastType: "success" | "info" | "error" = "success"): unknown {
  return {
    toast: { type: toastType, content: toastText },
    card: { type: "raw", data: renderAnsweredCard(cardInputOf(q)) },
  };
}

/** 卡回调 → 响应（更新卡+toast）。按 value 形态路由：普通问答卡 / 选择卡（selectQuestionId，T6）。
 *  返回 undefined = 不认识的卡 action（ack 200 无 data，服务器视为空响应）。textPending = 选择卡待确认文本缓存（入站写/此处读，同实例）。
 *  sendText：独立出站通道（spec「回复经独立 send 通道，不与 ack 阻塞」）——仅选择卡判答异步用（LLM 归一化可能 >3s）。 */
export async function handleCardAction(
  deps: RunDeps,
  payload: unknown,
  textPending?: PendingTextCache,
  sendText?: (openId: string, content: string) => Promise<unknown>,
): Promise<unknown | undefined> {
  const sel = mapSelectAction(payload);
  if (sel) return handleSelectAnswer(deps, textPending, sel, sendText);
  const m = mapCardAction(payload);
  if (!m) return undefined;
  const user = deps.imStore?.resolve(m.openId, "feishu");
  if (!user) return { toast: { type: "error", content: "请先在 Web 绑定飞书后再操作" } };
  const q = deps.hitlStore.getQuestion(m.questionId);
  if (!q) return { toast: { type: "error", content: "卡已失效" } };
  if (q.status !== "pending") return answeredCardRsp(q, "该卡已被处理", "info"); // 陈旧点击：幂等，不二执
  const res = await dispatchCardAnswer(deps, q.conversationId, m.questionId, m.value, user.userId);
  if (!res.handled) {
    if (res.skipTurn) return answeredCardRsp(q, "该卡已被处理", "info"); // 并发已被收口
    return { toast: { type: "error", content: "无法处理该操作" } }; // 内容不命中选项（label 异常）
  }
  if (res.error) return { toast: { type: "error", content: res.error } };
  return answeredCardRsp(q, SUCCESS_MSG[q.kind ?? "ask"] ?? "已处理");
}

/** 选择卡点选 → 取缓存文本 → 异步对所选卡走单卡判答（judgeAskCard）+ CAS（不在 3s ack 窗内跑 LLM 轮）。
 *  立即 ack「已收到」→ 判答完成经 sendText 回执；成功消费缓存，失败保缓存供重试。 */
async function handleSelectAnswer(
  deps: RunDeps,
  textPending: PendingTextCache | undefined,
  sel: { questionId: number; openId: string },
  sendText?: (openId: string, content: string) => Promise<unknown>,
): Promise<unknown> {
  const user = deps.imStore?.resolve(sel.openId, "feishu");
  if (!user) return { toast: { type: "error", content: "请先在 Web 绑定飞书后再操作" } };
  const q = deps.hitlStore.getQuestion(sel.questionId);
  if (!q) return { toast: { type: "error", content: "卡已失效" } };
  if (q.status !== "pending") return answeredCardRsp(q, "该卡已被处理", "info"); // 已被并发处理 → 明确收口
  if (!textPending) return { toast: { type: "error", content: "选择卡未就绪，请重新输入回答" } };
  const text = textPending.get(sel.openId);
  if (!text) return { toast: { type: "error", content: "待回答的文本已过期，请重新输入回答" } }; // TTL 过/无缓存
  // 判答异步（LLM 轮可能 >3s，不进 ack 窗口；飞书 3s 无响应会重推 → CAS 幂等）。结果经 sendText 回执。
  void (async () => {
    try {
      await judgeAskCard(deps, q, text);
      const after = deps.hitlStore.getQuestion(sel.questionId);
      if (!after || after.status !== "answered") {
        await sendText?.(sel.openId, "暂时无法据此推进，请重试或点选卡片选项"); // 归一化失败，缓存保留
        return;
      }
      textPending.del(sel.openId); // 成功消费（下次打字再起新选择）
      await sendText?.(sel.openId, "已处理");
    } catch (e) {
      console.warn(`[im-select] 选择卡判答 q${sel.questionId} 失败：`, e instanceof Error ? e.message : e);
      await sendText?.(sel.openId, "暂时无法据此推进，请重试或点选卡片选项");
    }
  })();
  return { toast: { type: "info", content: "已收到，正在处理…" } };
}