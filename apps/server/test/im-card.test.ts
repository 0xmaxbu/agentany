// T3（#58）：卡片渲染（renderImCard 纯函数）+ 出站路由（hitl_request→卡 / hitl_answered→回执文本）。
// seam：纯函数直测结构（schema 2.0 / 按钮回调 value / footer 开放度显隐 / ≤30KB）+ 真 store + 假飞书断言收到
// interactive 卡 payload（真 wire 契约 via fake-feishu）。
import { describe, test, expect, beforeEach } from "bun:test";
import { renderImCard, isClosedChoice, cardJsonSize, FOOTER_OPEN_HINT } from "../src/im/card";

describe("renderImCard（飞书 Card 2.0 结构）", () => {
  test("结构：header 标题 / prompt div / 每选项一按钮（callback value={questionId,label}）", () => {
    const card: any = renderImCard({
      questionId: 7,
      kind: "ask",
      prompt: "预算区间？",
      options: [{ label: "<10w", value: "<10w" }, { label: ">50w", value: ">50w" }],
      resumeSchema: { _t: "object", shape: { budget: { _t: "string" } } }, // 开放 → footer 显
    });
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

  test("开放 schema → footer「直接回复你的想法」显", () => {
    const card: any = renderImCard({ questionId: 1, kind: "ask", prompt: "p", options: [{ label: "a", value: "a" }], resumeSchema: { _t: "object", shape: { x: { _t: "string" } } } });
    const footers = card.body.elements.filter((e: any) => e.tag === "div" && e.text?.content === FOOTER_OPEN_HINT);
    expect(footers).toHaveLength(1); // note 已废弃 → 与 prompt 同形 div（Card 2.0 breaking）
  });

  test("闭合枚举 → footer 隐（按钮全覆盖）", () => {
    const card: any = renderImCard({ questionId: 1, kind: "ask", prompt: "p", options: [{ label: "accept", value: "accept" }], resumeSchema: { _t: "enum", vals: ["accept"] } });
    expect(card.body.elements.some((e: any) => e.tag === "div" && e.text?.content === FOOTER_OPEN_HINT)).toBe(false);
  });

  test("approval/task 无 resumeSchema → footer 隐", () => {
    for (const kind of ["approval", "task"] as const) {
      const card: any = renderImCard({ questionId: 1, kind, prompt: "p", options: [{ label: "批准", value: "批准" }] });
      expect(card.body.elements.some((e: any) => e.tag === "div" && e.text?.content === FOOTER_OPEN_HINT)).toBe(false);
    }
  });

  test("Card 2.0 兼容：无 action 容器、无 note 组件（live smoke 已真飞书验）", () => {
    const card: any = renderImCard({ questionId: 1, kind: "ask", prompt: "p", options: [{ label: "a", value: "a" }] });
    expect(card.body.elements.some((e: any) => e.tag === "action")).toBe(false);
    expect(card.body.elements.some((e: any) => e.tag === "note")).toBe(false);
  });

  test("20 个选项 + 长 prompt → 整卡 ≤30KB（≤200 组件天然达标）", () => {
    const options = Array.from({ length: 20 }, (_, i) => ({ label: `选项 ${i}`, value: `v${i}` }));
    const card = renderImCard({ questionId: 1, kind: "ask", prompt: "请选择一个方向：".repeat(10), options, resumeSchema: { _t: "object", shape: { sel: { _t: "string" } } } });
    expect(cardJsonSize(card)).toBeLessThanOrEqual(30 * 1024);
  });
});

describe("isClosedChoice（footer 开放度口径）", () => {
  test("顶层单 enum / 对象形单 enum+optional → 闭合", () => {
    expect(isClosedChoice({ _t: "enum", vals: ["a", "b"] })).toBe(true);
    expect(isClosedChoice({ _t: "object", shape: { decision: { _t: "enum", vals: ["y", "n"] }, focus: { _t: "optional", inner: { _t: "string" } } } })).toBe(true);
  });
  test("开放形（string / object 无 enum / undefined）→ 开放", () => {
    expect(isClosedChoice({ _t: "object", shape: { plan: { _t: "string" } } })).toBe(false);
    expect(isClosedChoice(undefined)).toBe(false);
  });
});