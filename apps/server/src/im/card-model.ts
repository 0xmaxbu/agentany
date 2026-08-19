// 领域卡模型半边（ADR-0032 决策 3）：平台无关的卡素材装配与开放度判定。渲染（飞书 Card 2.0 发射）
// 下移 im/feishu/render.ts；本文件只做「question 行 → 领域卡模型」与 footer 开放度（isTextOk/openness）。
//
// 按钮回调 value = {questionId, value}，内层 value = 选项 label（answer content）——与 Web 卡同源：
// Web 卡按钮 POST /messages {content: 选项文本, inReplyTo: qid}，dispatch 靠 optionIndex(选项文本) 匹配
// （approval/task 按 index、ask 按 label→deterministicResumeData 取 ADR-0025 快照）。按钮带 label → T4 复用
// dispatch 零新逻辑、三 kind 全确定；label 与快照一一对应（引擎强制卡恒有快照，选项数与可映射值数一致）。
//
// footer「以上选项都不满意？直接回复你的想法」按 resumeSchema 开放度显隐：闭合枚举（singleEnumVals 有值）
// → 按钮全覆盖不显；开放 → 显（文本作答路径可走）。
import { singleEnumVals } from "../workflow-engine/ask";
import type { Schema } from "../workflow-engine/schema";
import type { ImCardModel, ImCardOption } from "./types";

export const KIND_TITLES: Record<string, string> = { ask: "提问", approval: "审批", task: "任务确认" };
export const FOOTER_OPEN_HINT = "以上选项都不满意？直接回复你的想法";

/** 闭合枚举 → 按钮全覆盖（footer 隐）；开放/未知 → footer 显。复用 ask.singleEnumVals（与 hitl-dispatch 同口径）。 */
export function isClosedChoice(resumeSchema: unknown): boolean {
  return singleEnumVals(resumeSchema as Schema | undefined).vals.length > 0;
}

/** footer 开面：仅 ask 卡且 schema 开放时显文本作答邀请——approval/task 文本不放行（恒按钮面，不误导）。 */
export function isTextOk(input: Pick<ImCardInputLike, "kind" | "resumeSchema">): boolean {
  return input.kind === "ask" && !isClosedChoice(input.resumeSchema);
}

interface ImCardInputLike {
  kind: string;
  resumeSchema?: unknown;
}

/** question 行 → 卡选项素材（values 快照优先；缺 → options label 回落——T3 路由与 T5 绑定补发同源）。 */
export function cardOptionsOf(q: { values?: unknown; options?: unknown }): ImCardOption[] {
  if (Array.isArray(q.values) && q.values.length > 0) {
    return (q.values as { label?: unknown; value?: unknown }[]).map((v) => ({ label: String(v.label ?? ""), value: v.value }));
  }
  return ((q.options as string[]) ?? []).map((label) => ({ label, value: label }));
}

/** question 行 → 领域卡模型（kind 归一化 + footerOpen 判定 + 素材同源）。T3 路由/绑定补发/已答渲染共用。 */
export function cardInputOf(q: { id: number; kind?: string | null; prompt: string; values?: unknown; options?: unknown; resumeSchema?: unknown }): ImCardModel {
  return {
    questionId: q.id,
    kind: (q.kind ?? "ask") as ImCardModel["kind"],
    prompt: q.prompt,
    options: cardOptionsOf(q),
    footerOpen: isTextOk({ kind: q.kind ?? "ask", resumeSchema: q.resumeSchema }),
  };
}