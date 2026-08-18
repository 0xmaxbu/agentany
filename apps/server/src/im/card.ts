// IM 交互卡片渲染（spec #55/T3 #58）：hitl_request → 飞书 Card 2.0。平台无关输入（IM 决策入口领域模型），
// 产出飞书 CardDocument（schema "2.0"）；钉钉等后续平台另出渲染器（领域输入共享）。
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

export const KIND_TITLES: Record<string, string> = { ask: "提问", approval: "审批", task: "任务确认" };
export const FOOTER_OPEN_HINT = "以上选项都不满意？直接回复你的想法";

/** 卡选项：label = 按钮文本/答案 content（dispatch label 匹配）；value = ADR-0025 选项值快照（点击确定性对位）。 */
export interface ImCardOption {
  label: string;
  value: unknown;
}

export interface ImCardInput {
  questionId: number;
  kind: "ask" | "approval" | "task";
  prompt: string;
  options: ImCardOption[];
  resumeSchema?: unknown;
}

/** 闭合枚举 → 按钮全覆盖（footer 隐）；开放/未知 → footer 显。复用 ask.singleEnumVals（与 hitl-dispatch 同口径）。 */
export function isClosedChoice(resumeSchema: unknown): boolean {
  return singleEnumVals(resumeSchema as Schema | undefined).vals.length > 0;
}

/** footer 开面：仅 ask 卡且 schema 开放时显文本作答邀请——approval/task 文本不放行（恒按钮面，不误导）。 */
export function isTextOk(input: Pick<ImCardInput, "kind" | "resumeSchema">): boolean {
  return input.kind === "ask" && !isClosedChoice(input.resumeSchema);
}

/** hitl_request → 飞书 Card 2.0（交互卡：prompt + 每选项一按钮 + 按开放度 footer）。纯函数，结构单测直测。 */
export function renderImCard(input: ImCardInput): unknown {
  const title = KIND_TITLES[input.kind] ?? "提问";
  const footer: unknown[] = isTextOk(input) ? [
    { tag: "note", elements: [{ tag: "plain_text", content: FOOTER_OPEN_HINT }] },
  ] : [];
  const actions: unknown[] = input.options.length > 0 ? [{
    tag: "action",
    actions: input.options.map((o) => ({
      tag: "button",
      text: { tag: "plain_text", content: o.label },
      behaviors: [{ type: "callback", value: { questionId: input.questionId, value: o.label } }],
    })),
  }] : [];
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title } },
    body: {
      elements: [
        { tag: "div", text: { tag: "lark_md", content: input.prompt } },
        ...actions,
        ...footer,
      ],
    },
  };
}

/** 已答态卡（T4 回调响应用）：按钮移除、显「✅ 已处理」——不误导（不能再点）。 */
export function renderAnsweredCard(input: ImCardInput): unknown {
  const title = KIND_TITLES[input.kind] ?? "提问";
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title } },
    body: {
      elements: [
        { tag: "div", text: { tag: "lark_md", content: input.prompt } },
        { tag: "note", elements: [{ tag: "plain_text", content: "✅ 已处理" }] },
      ],
    },
  };
}

/** 卡片序列化后 ≤30KB（飞书上限；超限回落文本由路由裁量）。 */
export function cardJsonSize(card: unknown): number {
  return JSON.stringify(card).length;
}