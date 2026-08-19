// Feishu Card 2.0 渲染（ADR-0032 决策 3）：平台 adapter 侧——输入领域卡模型（ImCardModel，footerOpen 领域已判），
// 产出飞书 CardDocument（schema "2.0"）。钉钉等后续平台的 adapter 另出渲染器（领域输入共享）。
// 卡序列化后 ≤30KB（飞书上限；超限自降在 adapter.sendCard，render 只提供尺寸判定）。
import type { ImCardModel } from "../types";
import { KIND_TITLES, FOOTER_OPEN_HINT } from "../card-model";

/** lark_md div（Card 2.0 文本块；1.0 的 note 已废弃——live smoke 修复，与 prompt 同形）。 */
export function larkMdDiv(content: string): unknown {
  return { tag: "div", text: { tag: "lark_md", content } };
}

/** hitl_request → 飞书 Card 2.0（交互卡：prompt + 每选项一按钮 + 按开放度 footer）。纯函数，结构单测直测。
 *  按钮直接铺 body.elements（tag:"button"）——live smoke 修复：Card 2.0 已废弃 1.0 的 action 容器（真飞书拒收）。 */
export function renderImCard(input: ImCardModel): unknown {
  const title = KIND_TITLES[input.kind] ?? "提问";
  const footer: unknown[] = input.footerOpen ? [larkMdDiv(FOOTER_OPEN_HINT)] : [];
  const buttons: unknown[] = input.options.map((o) => ({
    tag: "button",
    text: { tag: "plain_text", content: o.label },
    behaviors: [{ type: "callback", value: { questionId: input.questionId, value: o.label } }],
  }));
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title } },
    body: { elements: [larkMdDiv(input.prompt), ...buttons, ...footer] },
  };
}

/** 已答态卡（T4 回调响应用）：按钮移除、显「✅ 已处理」——不误导（不能再点）。 */
export function renderAnsweredCard(input: ImCardModel): unknown {
  const title = KIND_TITLES[input.kind] ?? "提问";
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title } },
    body: { elements: [larkMdDiv(input.prompt), larkMdDiv("✅ 已处理")] }, // note 已废弃（Card 2.0 breaking）；同形 div
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
        larkMdDiv("收到您的回答，但有多张卡片待处理。请点击您要回答的那张："),
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
export function truncatePrompt(prompt: string): string {
  const p = prompt.trim();
  return p.length > 40 ? `${p.slice(0, 40)}…` : p;
}

/** 卡片序列化后 ≤30KB（飞书上限）。 */
export function cardJsonSize(card: unknown): number {
  return JSON.stringify(card).length;
}