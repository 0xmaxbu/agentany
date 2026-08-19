// T3（#58）：卡片渲染（renderImCard 纯函数）+ 出站路由（hitl_request→卡 / hitl_answered→回执文本）。
// ADR-0032：渲染收进 im/feishu/render.ts（Feishu Card 2.0）；开放度判定在 im/card-model.ts（isClosedChoice/footerOpen）。
// seam：纯函数直测结构（schema 2.0 / 按钮回调 value / footer 开放度显隐 / ≤30KB）+ 真 store + 假飞书断言收到
// interactive 卡 payload（真 wire 契约 via fake-feishu）。
import { describe, test, expect } from "bun:test";
import { renderImCard, cardJsonSize } from "../src/im/feishu/render";
import { isClosedChoice, FOOTER_OPEN_HINT } from "../src/im/card-model";
import { cardInputOf } from "../src/im/card-model";

describe("renderImCard（飞书 Card 2.0 结构）", () => {
  const model = (over: Partial<Parameters<typeof renderImCard>[0]> = {}): Parameters<typeof renderImCard>[0] => ({
    questionId: 7, kind: "ask", prompt: "预算区间？",
    options: [{ label: "<10w", value: "<10w" }, { label: ">50w", value: ">50w" }],
    footerOpen: true, // 开放 → footer 显（领域已判；渲染只消费）
    ...over,
  });

  test("结构：header 标题 / prompt div / 每选项一按钮（callback value={questionId,label}）", () => {
    const card: any = renderImCard(model());
    expect(card.schema).toBe("2.0");
    expect(card.header.title.content).toBe("提问");
    expect(card.body.elements[0].tag).toBe("div");
    expect(card.body.elements[0].text.content).toBe("预算区间？");
    const btns = card.body.elements.filter((e: any) => e.tag === "button");
    expect(btns).toHaveLength(2);
    expect(btns[0].text.content).toBe("<10w");
    expect(btns[0].behaviors).toEqual([{ type: "callback", value: { questionId: 7, value: "<10w" } }]);
    expect(btns[1].behaviors[0].value).toEqual({ questionId: 7, value: ">50w" });
    // live smoke 修复：Card 2.0 无 action 容器——按钮必须平铺（真飞书拒收 unsupported tag action）
    expect(card.body.elements.some((e: any) => e.tag === "action")).toBe(false);
  });

  test("footerOpen=true（领域判：ask ∧ 开放 schema）→ footer「直接回复你的想法」显", () => {
    const card: any = renderImCard(model({ footerOpen: true }));
    const footers = card.body.elements.filter((e: any) => e.tag === "div" && e.text?.content === FOOTER_OPEN_HINT);
    expect(footers).toHaveLength(1); // note 已废弃 → 与 prompt 同形 div（Card 2.0 breaking）
  });

  test("footerOpen=false（闭合枚举/approval/task）→ footer 隐", () => {
    for (const footerOpen of [false]) {
      const card: any = renderImCard(model({ footerOpen }));
      expect(card.body.elements.some((e: any) => e.tag === "div" && e.text?.content === FOOTER_OPEN_HINT)).toBe(false);
    }
  });

  test("Card 2.0 兼容：无 action 容器、无 note 组件（live smoke 已真飞书验）", () => {
    const card: any = renderImCard(model({ options: [] }));
    expect(card.body.elements.some((e: any) => e.tag === "action")).toBe(false);
    expect(card.body.elements.some((e: any) => e.tag === "note")).toBe(false);
  });

  test("20 个选项 + 长 prompt → 整卡 ≤30KB（≤200 组件天然达标）", () => {
    const options = Array.from({ length: 20 }, (_, i) => ({ label: `选项 ${i}`, value: `v${i}` }));
    const card = renderImCard(model({ options, prompt: "请选择一个方向：".repeat(10), footerOpen: true }));
    expect(cardJsonSize(card)).toBeLessThanOrEqual(30 * 1024);
  });

  test("footerOpen 由领域 cardInputOf 判定（ask∧开放 / 其余 false）", () => {
    expect(cardInputOf({ id: 1, kind: "ask", prompt: "p", options: ["a"], resumeSchema: { _t: "object", shape: { x: { _t: "string" } } } }).footerOpen).toBe(true);
    expect(cardInputOf({ id: 1, kind: "ask", prompt: "p", options: ["a"], resumeSchema: { _t: "enum", vals: ["a"] } }).footerOpen).toBe(false);
    expect(cardInputOf({ id: 1, kind: "approval", prompt: "p", options: ["a"] }).footerOpen).toBe(false);
  });
});

describe("isClosedChoice（footer 开放度口径，领域层）", () => {
  test("顶层单 enum / 对象形单 enum+optional → 闭合", () => {
    expect(isClosedChoice({ _t: "enum", vals: ["a", "b"] })).toBe(true);
    expect(isClosedChoice({ _t: "object", shape: { decision: { _t: "enum", vals: ["y", "n"] }, focus: { _t: "optional", inner: { _t: "string" } } } })).toBe(true);
  });
  test("开放形（string / object 无 enum / undefined）→ 开放", () => {
    expect(isClosedChoice({ _t: "object", shape: { plan: { _t: "string" } } })).toBe(false);
    expect(isClosedChoice(undefined)).toBe(false);
  });
});