// 飞书卡回调响应组装（ADR-0032 决策 6：ack 组装留 feishu 侧）。dispatch 回 ack 素材（ImCardAck）→ 本文件组
// { toast, card:{ type:"raw", data: renderAnsweredCard(领域模型) } }——live smoke 修复：裸卡 JSON 被飞书判 200673
// 「返回了错误的卡片」→ 必须 raw 包装。
import type { ImCardAck } from "../types";
import { cardInputOf } from "../card-model";
import { renderAnsweredCard } from "./render";
import type { QuestionRow } from "../../hitl/store";

/** 卡回调响应：toast + 已答态卡（更新原卡）。无 question（未答/错误）→ 仅 toast。 */
export function answeredCardRsp(ack: ImCardAck): unknown {
  if (ack.answered && ack.question) {
    return {
      toast: ack.toast,
      card: { type: "raw", data: renderAnsweredCard(cardInputOf(ack.question as QuestionRow)) },
    };
  }
  return { toast: ack.toast };
}