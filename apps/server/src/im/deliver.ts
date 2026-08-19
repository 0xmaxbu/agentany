// IM 出站投递（ADR-0032 决策 4/5/7）：两件——
// - renderHitlFrame：hitl 帧 → 纯文本（T3 回执/回落基线；自 im/outbound.ts 迁入）。
// - sendCardGuarded：领域卡投递守卫——optionless（无按钮=平台无关形态不可能）→ 降 sendText(textFallback)。
//   oversize（30KB 是飞书媒体上限、平台特有）→ FeishuPlatformAdapter.sendCard 内部自判自降。backfill 同走此守卫。
import type { Frame } from "../chat/eventbus";
import type { ImCardModel } from "./types";
import type { ImPlatformAdapter } from "./types";
import { KIND_TITLES, FOOTER_OPEN_HINT } from "./card-model";

const KIND_LABELS = KIND_TITLES;

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

/** 领域卡模型 → 纯文本（optionless 兜底/超限回落/补发 textFallback 共用同源）。 */
export function cardModelToText(card: ImCardModel): string {
  const label = KIND_LABELS[card.kind] ?? "提问";
  const optsList = card.options.length ? `\n选项：\n${card.options.map((o) => `- ${o.label}`).join("\n")}` : "";
  return `${label}：${card.prompt}${optsList}`;
}

/** 领域卡投递守卫（决策 4/5）：optionless → 纯文本兜底；否则交 adapter（其内自判 oversize）。
 *  backfill（绑定补发）与 T3 路由同走本函数——复渲染两张脸物理合一，optionless/超大卡风险归零。 */
export async function sendCardGuarded(
  adapter: ImPlatformAdapter,
  to: string,
  card: ImCardModel,
  opts?: { uuid?: string; textFallback?: string },
): Promise<void> {
  if (card.options.length === 0) {
    await adapter.sendText(to, opts?.textFallback ?? cardModelToText(card), { uuid: opts?.uuid });
    return;
  }
  await adapter.sendCard(to, card, { uuid: opts?.uuid, textFallback: opts?.textFallback ?? cardModelToText(card) });
}