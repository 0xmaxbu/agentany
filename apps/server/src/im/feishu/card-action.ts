// 飞书卡按钮回调处理（spec #55/T4 #59）：card.action.trigger → 映射 value → 复用 hitl-dispatch（CAS 收口）
// → 组装回调响应（更新卡 + toast）。应答经长连接 ack 的 data 字段回传（data=base64(JSON{rsp})，node SDK 同款）。
//
// 回调 value = {questionId, value: 选项label}（T3 决策）。点击者 = operator.open_id（绑定的用户身份）→
// dispatchCardAnswer 以该 userId 落定（approval 记录决策人；task 卡主守卫）。
//
// 幂等：已答/并发 → dispatch 返回 skipTurn → 响应「该卡已被处理」卡 + toast（不二次执行——CAS 收口）。
// 响应格式（v1 契约，live smoke 最终验收）：{ toast: {type, content}, card: <已答卡 2.0> }。
import type { RunDeps } from "../../runs";
import type { QuestionRow } from "../../workflow-engine/store";
import { dispatchCardAnswer } from "../../chat/hitl-dispatch";
import { renderAnsweredCard } from "../card";

export interface CardActionInput {
  questionId: number;
  value: string; // 选项 label（按钮 content）
  openId: string; // 点击者 open_id
}

/** card.action.trigger 事件 → {questionId, value, openId}；value 缺/类型错/无操作者 → null。纯函数单测直测。 */
export function mapCardAction(payload: unknown): CardActionInput | null {
  const ev = (payload as { event?: Record<string, any> }).event;
  const value = ev?.action?.value;
  if (!value || typeof value.questionId !== "number" || typeof value.value !== "string") return null;
  const openId = ev?.operator?.open_id;
  if (!openId) return null;
  return { questionId: value.questionId, value: value.value, openId };
}

const SUCCESS_MSG: Record<string, string> = { ask: "已处理", approval: "已审批", task: "已确认" };

export function answeredCardRsp(q: QuestionRow, toastText: string, toastType: "success" | "info" | "error" = "success"): unknown {
  return {
    toast: { type: toastType, content: toastText },
    card: renderAnsweredCard({ questionId: q.id, kind: (q.kind ?? "ask") as "ask" | "approval" | "task", prompt: q.prompt, options: [] }),
  };
}

/** 卡回调 → 响应（更新卡+toast）。返回 undefined = 不认识的卡 action（ack 200 无 data，服务器视为空响应）。 */
export async function handleCardAction(deps: RunDeps, payload: unknown): Promise<unknown | undefined> {
  const m = mapCardAction(payload);
  if (!m) return undefined;
  const user = deps.imStore?.resolve(m.openId, "feishu");
  if (!user) return { toast: { type: "error", content: "请先在 Web 绑定飞书后再操作" } };
  const q = deps.store.getQuestion(m.questionId);
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