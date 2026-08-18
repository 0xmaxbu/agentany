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

/** question 行 → 卡选项素材（values 快照优先；缺 → options label 回落——T3 路由与 T5 绑定补发同源）。 */
export function cardOptionsOf(q: { values?: unknown; options?: unknown }): ImCardOption[] {
  if (Array.isArray(q.values) && q.values.length > 0) {
    return (q.values as { label?: unknown; value?: unknown }[]).map((v) => ({ label: String(v.label ?? ""), value: v.value }));
  }
  return ((q.options as string[]) ?? []).map((label) => ({ label, value: label }));
}

/** footer 开面：仅 ask 卡且 schema 开放时显文本作答邀请——approval/task 文本不放行（恒按钮面，不误导）。 */
export function isTextOk(input: Pick<ImCardInput, "kind" | "resumeSchema">): boolean {
  return input.kind === "ask" && !isClosedChoice(input.resumeSchema);
}

/** hitl_request → 飞书 Card 2.0（交互卡：prompt + 每选项一按钮 + 按开放度 footer）。纯函数，结构单测直测。
 *  按钮直接铺 body.elements（tag:"button"）——live smoke 修复：Card 2.0 已废弃 1.0 的 action 容器（真飞书拒收）。 */
export function renderImCard(input: ImCardInput): unknown {
  const title = KIND_TITLES[input.kind] ?? "提问";
  const footer: unknown[] = isTextOk(input) ? [
    { tag: "div", text: { tag: "lark_md", content: FOOTER_OPEN_HINT } }, // note 已废弃（Card 2.0 breaking）；与 prompt 同形 div（live smoke 验证通过）
  ] : [];
  const buttons: unknown[] = input.options.map((o) => ({
    tag: "button",
    text: { tag: "plain_text", content: o.label },
    behaviors: [{ type: "callback", value: { questionId: input.questionId, value: o.label } }],
  }));
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title } },
    body: {
      elements: [
        { tag: "div", text: { tag: "lark_md", content: input.prompt } },
        ...buttons,
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
        { tag: "div", text: { tag: "lark_md", content: "✅ 已处理" } }, // note 已废弃（Card 2.0 breaking）；同形 div
      ],
    },
  };
}

/** 选择卡（spec #55/T6）：多条 pending ask 卡并存时，把「待确认文本」挂到选择——每张卡一个按钮（仅 prompt）。
 *  按钮回调 value = { selectQuestionId }——与普通卡 {questionId, label} 区分（card-action 按字段路由）。
 *  按钮同样平铺（Card 2.0 无 action 容器，live smoke 修复）。 */
export function renderSelectCard(candidates: { questionId: number; prompt: string }[]): unknown {
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "多张待处理卡片" } },
    body: {
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "收到您的回答，但有多张卡片待处理。请点击您要回答的那张：" } },
        ...candidates.map((c) => ({
          tag: "button",
          text: { tag: "plain_text", content: truncatePrompt(c.prompt) }, // 仅 prompt（不展开选项明细分）
          behaviors: [{ type: "callback", value: { selectQuestionId: c.questionId } }],
        })),
      ],
    },
  };
}

/** 选择卡按钮文案：prompt 截断（≤40 字符，防按钮撑爆）。 */
function truncatePrompt(prompt: string): string {
  const p = prompt.trim();
  return p.length > 40 ? `${p.slice(0, 40)}…` : p;
}

/** 卡片序列化后 ≤30KB（飞书上限；超限回落文本由路由裁量）。 */
export function cardJsonSize(card: unknown): number {
  return JSON.stringify(card).length;
}