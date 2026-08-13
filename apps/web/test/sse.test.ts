// SSE parser 单测（ADR-0009 BE-Q4 wire format）。纯函数、bun 跑、不开浏览器。
import { describe, test, expect } from "bun:test";
import { parseSSEFrames } from "../src/sse";

describe("SSE parser", () => {
  test("解析 delta×2 + done（多帧顺序）", () => {
    const buf =
      'data: {"type":"delta","text":"Hel"}\n\ndata: {"type":"delta","text":"lo"}\n\ndata: {"type":"done","messageId":7,"text":"Hello"}\n\n';
    const { events, rest } = parseSSEFrames(buf);
    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done", messageId: 7, text: "Hello" },
    ]);
    expect(rest).toBe("");
  });

  test("忽略 : ping 心跳注释帧", () => {
    const buf = ': ping\n\ndata: {"type":"delta","text":"x"}\n\n';
    const { events } = parseSSEFrames(buf);
    expect(events).toEqual([{ type: "delta", text: "x" }]);
  });

  test("error 帧解析", () => {
    const { events } = parseSSEFrames('data: {"type":"error","message":"boom"}\n\n');
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });

  test("aborted done 帧", () => {
    const { events } = parseSSEFrames('data: {"type":"done","messageId":0,"text":"部分","aborted":true}\n\n');
    expect(events[0]).toMatchObject({ type: "done", aborted: true });
  });

  test("跨块：保留不完整片段到 rest，续块接上", () => {
    const r1 = parseSSEFrames('data: {"type":"delta","text":"a"}\n\ndata: {"type":"delta","text":"b"');
    expect(r1.events).toEqual([{ type: "delta", text: "a" }]);
    expect(r1.rest).toBe('data: {"type":"delta","text":"b"');
    const r2 = parseSSEFrames(r1.rest + '}\n\n');
    expect(r2.events).toEqual([{ type: "delta", text: "b" }]);
    expect(r2.rest).toBe("");
  });

  test("非 JSON / 无 type 帧忽略", () => {
    const { events } = parseSSEFrames("data: not json\n\ndata: {}\n\n");
    expect(events).toEqual([]);
  });

  test("多行 data（按 SSE 规范用 \\n 拼接）", () => {
    const buf = 'data: {"type":"delta","text":"line1\\nline2"}\n\n';
    const { events } = parseSSEFrames(buf);
    expect(events).toEqual([{ type: "delta", text: "line1\nline2" }]);
  });
});
