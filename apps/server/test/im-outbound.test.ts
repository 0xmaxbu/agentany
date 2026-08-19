// T3（#52）：IM 出站通知渲染——hitl_request 一帧多端：EventBus 订阅渲染器把卡转纯文本（prompt + options label），
// hitl_answered → 「已处理：…」确认文本。ADR-0032 决策 7：ImOutboundAdapter 死码已删；renderHitlFrame 迁入 im/deliver.ts。
// seam：renderHitlFrame 纯函数（输入 Frame → text|null）+ sendCardGuarded 守卫（optionless→文本兜底）。
import { describe, test, expect } from "bun:test";
import type { Frame } from "../src/chat/eventbus";
import { renderHitlFrame, sendCardGuarded } from "../src/im/deliver";
import { cardInputOf } from "../src/im/card-model";

const ask = (over: Partial<Extract<Frame, { type: "hitl_request" }>> = {}): Extract<Frame, { type: "hitl_request" }> => ({
  type: "hitl_request", questionId: 1, runId: null, prompt: "选哪个方案？", options: ["方案A", "方案B"], ...over,
});

describe("renderHitlFrame：hitl_request → 纯文本（prompt + 全量 options label）", () => {
  test("ask 卡：含提问标签 + prompt + 全部选项（无卡 ID/序列号废话）", () => {
    const t = renderHitlFrame(ask({ kind: "ask" }))!;
    expect(t).toContain("提问");
    expect(t).toContain("选哪个方案？");
    expect(t).toContain("方案A");
    expect(t).toContain("方案B");
    expect(t).not.toContain("1"); // questionId 不进 IM 文本（无废话）
  });

  test("approval 卡：审批标签 + 选项对位", () => {
    const t = renderHitlFrame(ask({ kind: "approval", prompt: "需审批", options: ["批准", "拒绝"] }))!;
    expect(t).toContain("审批");
    expect(t).toContain("需审批");
    expect(t).toContain("批准");
    expect(t).toContain("拒绝");
  });

  test("task 卡：任务确认为表意标签", () => {
    const t = renderHitlFrame(ask({ kind: "task", prompt: "确认任务", options: ["确认创建", "取消"] }))!;
    expect(t).toContain("任务确认");
    expect(t).toContain("确认创建");
    expect(t).toContain("取消");
  });

  test("空 options → 无选项段（仅 prompt）", () => {
    const t = renderHitlFrame(ask({ options: [] }))!;
    expect(t).toContain("选哪个方案？");
    expect(t).not.toContain("选项");
  });

  test("多选项长列表 → 每个 label 独占一行、全量保留", () => {
    const many = Array.from({ length: 12 }, (_, i) => `option-${i + 1}`);
    const t = renderHitlFrame(ask({ options: many }))!;
    for (const m of many) expect(t).toContain(m);
    const lines = t.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(12);
  });

  test("无 kind 字段 → 按 ask 渲染（默认）", () => {
    const t = renderHitlFrame(ask({ kind: undefined }))!;
    expect(t).toContain("提问");
  });
});

describe("renderHitlFrame：hitl_answered → 已处理确认", () => {
  test("含答案摘要（对象 → JSON）", () => {
    const t = renderHitlFrame({ type: "hitl_answered", questionId: 3, answer: { decision: "accept" }, kind: "ask" })!;
    expect(t).toContain("已处理");
    expect(t).toContain('"accept"');
  });

  test("字符串答案 → 直写无转义噪声（免 JSON.stringify 引号）", () => {
    const t = renderHitlFrame({ type: "hitl_answered", questionId: 3, answer: "同意批准", kind: "ask" })!;
    expect(t).toBe("已处理：同意批准"); // 无引号/转义
  });

  test("空答案 → 仅「已处理」", () => {
    const t = renderHitlFrame({ type: "hitl_answered", questionId: 3, answer: null, kind: "ask" })!;
    expect(t).toBe("已处理");
  });
});

describe("renderHitlFrame：非 hitl 帧 → null（不产出 IM 文本）", () => {
  test("block_delta / user_message / done / error 均 null", () => {
    expect(renderHitlFrame({ type: "block_delta", blockId: "b", delta: "x" })).toBeNull();
    expect(renderHitlFrame({ type: "user_message", id: 1, content: "hi" })).toBeNull();
    expect(renderHitlFrame({ type: "done", messageId: 1 })).toBeNull();
    expect(renderHitlFrame({ type: "error", message: "boom" })).toBeNull();
    expect(renderHitlFrame({ type: "run_completed", runId: "r1" })).toBeNull();
  });
});

describe("sendCardGuarded（ADR-0032 决策 4/5：领域投递守卫）", () => {
  // memory adapter：记录出站调用（验证 optionless/有选项/超限 各分支落在哪个出口）。
  function memAdapter() {
    const calls: { kind: "text" | "card"; to: string; text?: string; card?: Parameters<typeof import("../src/im/feishu/render").renderImCard>[0] }[] = [];
    const adapter = {
      platform: "memory",
      sendText: async (to: string, text: string) => { calls.push({ kind: "text", to, text }); },
      sendCard: async (to: string, card: any) => { calls.push({ kind: "card", to, card }); },
      parseInbound: () => null,
      start: () => ({ stop: () => {} }),
    };
    return { adapter, calls };
  }

  test("有选项 → sendCard（交 adapter 渲染/超限自判）", async () => {
    const { adapter, calls } = memAdapter();
    await sendCardGuarded(adapter, "ou_1", cardInputOf({ id: 5, kind: "ask", prompt: "选？", options: ["A"] }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "card", to: "ou_1" });
  });

  test("optionless（无按钮形态不可能）→ sendText 兜底（textFallback 优先；缺省领域卡文本）", async () => {
    const { adapter, calls } = memAdapter();
    await sendCardGuarded(adapter, "ou_1", cardInputOf({ id: 5, kind: "approval", prompt: "无选项审批", options: [] }), { textFallback: "无按钮：请去 Web 处理" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ kind: "text", to: "ou_1", text: "无按钮：请去 Web 处理" });

    const { adapter: a2, calls: c2 } = memAdapter();
    await sendCardGuarded(a2, "ou_2", cardInputOf({ id: 6, kind: "ask", prompt: "t", options: [] }));
    expect(c2[0]).toMatchObject({ kind: "text", to: "ou_2" });
    expect(c2[0].text).toContain("t"); // 缺省 textFallback = 领域卡文本（prompt 在）
  });
});