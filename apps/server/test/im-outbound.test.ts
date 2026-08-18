// T3（#52）：IM 出站通知渲染——hitl_request 一帧多端：EventBus 订阅渲染器把卡转纯文本（prompt + options label），
// hitl_answered → 「已处理：…」确认文本。纯函数 + 平台无关适配器壳（真实 IM 平台接缝下游）。
// seam：renderHitlFrame 纯函数（输入 Frame → text|null）+ ImOutboundAdapter 真 EventBus 订阅（多会话隔离）。
import { describe, test, expect } from "bun:test";
import { EventBus, type Frame } from "../src/chat/eventbus";
import { ImOutboundAdapter, renderHitlFrame } from "../src/im/outbound";

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

describe("ImOutboundAdapter：EventBus 订阅随帧渲染（生命周期/多会话隔离）", () => {
  test("订阅后 hitl_request 帧 → deliver 收到渲染文本；解订阅后不再接收", () => {
    const bus = new EventBus();
    const delivered: string[] = [];
    const adapter = new ImOutboundAdapter(bus, (t) => delivered.push(t));
    const unsub = adapter.subscribe("c1");
    bus.publish("c1", { type: "hitl_request", questionId: 1, runId: null, prompt: "选哪个？", options: ["A", "B"] });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("A");
    unsub();
    bus.publish("c1", { type: "hitl_request", questionId: 2, runId: null, prompt: "再选", options: ["C"] });
    expect(delivered).toHaveLength(1); // 退订后不再渲染
  });

  test("多会话隔离：c1 的帧只进 c1 deliver，不串到 c2", () => {
    const bus = new EventBus();
    const c1: string[] = [], c2: string[] = [];
    const adapter = new ImOutboundAdapter(bus); // 无默认 deliver——subscribe 时逐会话注入
    const a1 = adapter.subscribe("c1", (t) => c1.push(t));
    const a2 = adapter.subscribe("c2", (t) => c2.push(t));
    bus.publish("c1", { type: "hitl_request", questionId: 1, runId: null, prompt: "c1 的问题", options: ["X"] });
    bus.publish("c2", { type: "hitl_answered", questionId: 2, answer: { ok: 1 } });
    expect(c1).toHaveLength(1);
    expect(c1[0]).toContain("c1 的问题");
    expect(c2).toHaveLength(1);
    expect(c2[0]).toContain("已处理");
    a1(); a2();
  });

  test("非 hitl 帧不产出（SSE 显卡路径不受损：第三订阅者仍收原始帧）", () => {
    const bus = new EventBus();
    const imOut: string[] = [];
    const rawFrames: Frame[] = [];
    const adapter = new ImOutboundAdapter(bus, (t) => imOut.push(t));
    const unsubIm = adapter.subscribe("c1");
    const unsubRaw = bus.subscribe("c1", (f) => rawFrames.push(f)); // 模拟 SSE 持久流订阅
    bus.publish("c1", { type: "block_delta", blockId: "b", delta: "tok" });
    bus.publish("c1", { type: "hitl_request", questionId: 9, runId: "r_9", prompt: "批吗", options: ["批", "否"], kind: "approval" });
    expect(imOut).toHaveLength(1); // 仅 hitl 帧被 IM 渲染
    expect(rawFrames).toHaveLength(2); // SSE 端原始帧全收（含非 hitl），无回归
    expect(rawFrames[0].type).toBe("block_delta");
    unsubIm(); unsubRaw();
  });
});