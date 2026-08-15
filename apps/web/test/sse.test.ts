// SSE parser 单测（ADR-0009 BE-Q4 wire format；f3 帧改 block 三帧）。纯函数、bun 跑、不开浏览器。
import { describe, test, expect } from "bun:test";
import { parseSSEFrames } from "../src/sse";

describe("SSE parser", () => {
  test("解析 block 三帧 + done（多帧顺序）", () => {
    const buf =
      'data: {"type":"block_start","blockId":"b1","kind":"text"}\n\ndata: {"type":"block_delta","blockId":"b1","delta":"Hel"}\n\ndata: {"type":"block_end","blockId":"b1"}\n\ndata: {"type":"done","messageId":7}\n\n';
    const { events, rest } = parseSSEFrames(buf);
    expect(events).toEqual([
      { type: "block_start", blockId: "b1", kind: "text" },
      { type: "block_delta", blockId: "b1", delta: "Hel" },
      { type: "block_end", blockId: "b1" },
      { type: "done", messageId: 7 },
    ]);
    expect(rest).toBe("");
  });

  test("忽略 : ping 心跳注释帧", () => {
    const buf = ': ping\n\ndata: {"type":"block_delta","blockId":"b1","delta":"x"}\n\n';
    const { events } = parseSSEFrames(buf);
    expect(events).toEqual([{ type: "block_delta", blockId: "b1", delta: "x" }]);
  });

  test("error 帧解析", () => {
    const { events } = parseSSEFrames('data: {"type":"error","message":"boom"}\n\n');
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });

  test("aborted done 帧", () => {
    const { events } = parseSSEFrames('data: {"type":"done","messageId":0,"aborted":true}\n\n');
    expect(events[0]).toMatchObject({ type: "done", aborted: true });
  });

  test("跨块：保留不完整片段到 rest，续块接上", () => {
    const r1 = parseSSEFrames('data: {"type":"block_delta","blockId":"b1","delta":"a"}\n\ndata: {"type":"block_delta","blockId":"b1","delta":"b"');
    expect(r1.events).toEqual([{ type: "block_delta", blockId: "b1", delta: "a" }]);
    expect(r1.rest).toBe('data: {"type":"block_delta","blockId":"b1","delta":"b"');
    const r2 = parseSSEFrames(r1.rest + '}\n\n');
    expect(r2.events).toEqual([{ type: "block_delta", blockId: "b1", delta: "b" }]);
    expect(r2.rest).toBe("");
  });

  test("非 JSON / 无 type 帧忽略", () => {
    const { events } = parseSSEFrames("data: not json\n\ndata: {}\n\n");
    expect(events).toEqual([]);
  });

  test("多行 data（按 SSE 规范用 \\n 拼接）", () => {
    const buf = 'data: {"type":"block_delta","blockId":"b1","delta":"line1\\nline2"}\n\n';
    const { events } = parseSSEFrames(buf);
    expect(events).toEqual([{ type: "block_delta", blockId: "b1", delta: "line1\nline2" }]);
  });
});
