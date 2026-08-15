// blocks 三帧发射器（#20）：pi NDJSON 事件 → StreamBlock。纯函数，无 IO。
import { describe, test, expect } from "bun:test";
import { createBlockEmitter, flattenText } from "../src/blocks";

const upd = (d: any) => ({ type: "message_update", assistantMessageEvent: d });

describe("blocks.createBlockEmitter", () => {
  test("text/thinking 交替 → start/delta/end 序列 + blockId 稳定", () => {
    const em = createBlockEmitter();
    const out = [
      ...em(upd({ type: "thinking_start" })),
      ...em(upd({ type: "thinking_delta", delta: "想想" })),
      ...em(upd({ type: "thinking_end" })),
      ...em(upd({ type: "text_start" })),
      ...em(upd({ type: "text_delta", delta: "你好" })),
      ...em(upd({ type: "text_delta", delta: "世界" })),
      ...em(upd({ type: "text_end" })),
    ];
    expect(out).toEqual([
      { op: "start", blockId: "b1", kind: "thinking" },
      { op: "delta", blockId: "b1", delta: "想想" },
      { op: "end", blockId: "b1" },
      { op: "start", blockId: "b2", kind: "text" },
      { op: "delta", blockId: "b2", delta: "你好" },
      { op: "delta", blockId: "b2", delta: "世界" },
      { op: "end", blockId: "b2" },
    ]);
  });

  test("toolcall_end → tool_use start(含完整 meta)+end，blockId=toolCall.id", () => {
    const em = createBlockEmitter();
    const out = em(upd({ type: "toolcall_end", toolCall: { id: "call_00_x", name: "start_workflow", arguments: { workflowId: "wf" } } }));
    expect(out).toEqual([
      { op: "start", blockId: "call_00_x", kind: "tool_use", meta: { toolCallId: "call_00_x", name: "start_workflow", arguments: { workflowId: "wf" } } },
      { op: "end", blockId: "call_00_x" },
    ]);
  });

  test("tool_execution_end → tool_result start/delta(text)/end，blockId=r_<toolCallId>", () => {
    const em = createBlockEmitter();
    const out = em({ type: "tool_execution_end", toolCallId: "call_00_x", toolName: "start_workflow", result: { content: [{ type: "text", text: "200 {ok}" }] }, isError: false });
    expect(out).toEqual([
      { op: "start", blockId: "r_call_00_x", kind: "tool_result", meta: { toolCallId: "call_00_x", toolName: "start_workflow", isError: false } },
      { op: "delta", blockId: "r_call_00_x", delta: "200 {ok}" },
      { op: "end", blockId: "r_call_00_x" },
    ]);
  });

  test("未开放块收到 delta → 丢弃不炸；未知事件 → 空", () => {
    const em = createBlockEmitter();
    expect(em(upd({ type: "text_delta", delta: "孤儿" }))).toEqual([]); // 无 start
    expect(em({ type: "turn_end" })).toEqual([]);
    expect(em(null)).toEqual([]);
  });

  test("块未 end 就开新块（防御：pi 保证交替，但孤儿不崩）", () => {
    const em = createBlockEmitter();
    const a = em(upd({ type: "text_start" }));
    const b = em(upd({ type: "thinking_start" })); // text 未 end 直接 thinking_start
    expect(a[0].blockId).toBe("b1");
    expect(b[0].blockId).toBe("b2"); // 新开块，旧 b1 的 end 由 pi 事件顺序保证（实测交替）
  });

  // 真 pi 实测（2026-08-15 实机调试抓包）：text_start 可先于 thinking_end 到达（content 交错）。
  // 单 open 指针会把迟到的 thinking_end 错关到 text 块——thinking 永不收尾（UI 卡「思考中…」）。
  test("交错序：thinking_delta → text_start → text_delta → thinking_end → text_end（按 contentIndex 对位）", () => {
    const em = createBlockEmitter();
    const out = [
      ...em(upd({ type: "thinking_start", contentIndex: 0 })),
      ...em(upd({ type: "thinking_delta", contentIndex: 0, delta: "想想" })),
      ...em(upd({ type: "text_start", contentIndex: 1 })), // 交错：thinking 未 end
      ...em(upd({ type: "text_delta", contentIndex: 1, delta: "答" })),
      ...em(upd({ type: "thinking_end", contentIndex: 0, content: "想想" })), // 迟到
      ...em(upd({ type: "text_end", contentIndex: 1, content: "答" })),
    ];
    expect(out).toEqual([
      { op: "start", blockId: "b1", kind: "thinking" },
      { op: "delta", blockId: "b1", delta: "想想" },
      { op: "start", blockId: "b2", kind: "text" },
      { op: "delta", blockId: "b2", delta: "答" },
      { op: "end", blockId: "b1" }, // 关的是 thinking（b1）不是 text
      { op: "end", blockId: "b2" },
    ]);
  });

  test("无 contentIndex 的事件（防御旧形状）→ 回退最近开放块", () => {
    const em = createBlockEmitter();
    const out = [
      ...em(upd({ type: "text_start" })),
      ...em(upd({ type: "text_delta", delta: "旧形状" })),
      ...em(upd({ type: "text_end" })),
    ];
    expect(out).toEqual([
      { op: "start", blockId: "b1", kind: "text" },
      { op: "delta", blockId: "b1", delta: "旧形状" },
      { op: "end", blockId: "b1" },
    ]);
  });
});

describe("blocks.flattenText", () => {
  test("string 直通；parts 拼 text；对象 JSON 化", () => {
    expect(flattenText("abc")).toBe("abc");
    expect(flattenText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
    expect(flattenText([{ type: "image", data: "x" }])).toBe("[图片]");
    expect(flattenText({ foo: 1 })).toBe('{"foo":1}');
    expect(flattenText(null)).toBe("");
  });
});
