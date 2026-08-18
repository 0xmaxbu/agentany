// IM 出站通知（spec #49 决策 3；T3 #52）：hitl_request 帧多端同放——EventBus 订阅渲染器把卡转 IM 纯文本。
// 唯一形态 = 纯文本（prompt + options label 列表；无序列号/无卡 ID 废话）；不为此设计 IM 专用 payload。
// 纯函数渲染（renderHitlFrame，不依赖任何 IM SDK）+ 平台无关适配器壳（ImOutboundAdapter，deliver 由真实平台插接，
// 平台选型是下游工作）。SSE 端仍是显卡路径（本模块只读帧不拦截——第三订阅者照收原始帧，零回归）。
import type { EventBus, Frame } from "../chat/eventbus";

export type ImDeliver = (text: string) => void;

const KIND_LABELS: Record<string, string> = {
  ask: "提问",
  approval: "审批",
  task: "任务确认",
};

/** hitl_request → 纯文本通知；hitl_answered → 已处理确认；其余帧 → null（不产出 IM 文本）。 */
export function renderHitlFrame(f: Frame): string | null {
  switch (f.type) {
    case "hitl_request": {
      const label = KIND_LABELS[f.kind ?? "ask"] ?? "提问";
      const options = f.options ?? [];
      const optsList = options.length ? `\n选项：\n${options.map((o) => `- ${o}`).join("\n")}` : "";
      return `${label}：${f.prompt}${optsList}`;
    }
    case "hitl_answered": {
      const a: unknown = f.answer;
      // primitives 直写（免 JSON 转义噪声）；对象仍序列化（honest payload）
      const text = typeof a === "string" || typeof a === "number" || typeof a === "boolean"
        ? String(a)
        : a == null ? "" : JSON.stringify(a);
      return `已处理${text ? `：${text}` : ""}`;
    }
    default:
      return null;
  }
}

export class ImOutboundAdapter {
  constructor(private bus: EventBus, private defaultDeliver?: ImDeliver) {}

  /** 订阅某会话：hitl 帧 → 渲染纯文本 → deliver（未传每订阅 deliver 时用构造默认；均缺 → 吞掉）。返退订函数。 */
  subscribe(conversationId: string, deliver?: ImDeliver): () => void {
    const send = deliver ?? this.defaultDeliver;
    return this.bus.subscribe(conversationId, (f) => {
      const text = renderHitlFrame(f);
      if (text !== null && send) send(text);
    });
  }
}