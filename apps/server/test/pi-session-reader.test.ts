// pi-session reader（#20）：session jsonl → HistoryMessage（blocks 同构）。fixture 取自实测样例（二次审核取证）。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readConversationHistory } from "../src/pi-session/reader";

const DIR = join(tmpdir(), `pi-session-reader-test-${process.pid}`);

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

// 实测样例结构（脱敏截断）：header + user(parts) + assistant(thinking+text+toolCall) + toolResult
const FIXTURE = [
  { type: "session", version: 3, id: "chat-c_test", timestamp: "2026-08-14T00:00:00.000Z", cwd: "/w" },
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-08-14T00:00:01.000Z", provider: "go", modelId: "deepseek-v4-flash" },
  { type: "message", id: "e1", parentId: "m1", timestamp: "2026-08-14T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "帮我调研" }], timestamp: 1 } },
  { type: "message", id: "e2", parentId: "e1", timestamp: "2026-08-14T00:00:03.000Z", message: { role: "assistant", content: [
    { type: "thinking", thinking: "先想一下" },
    { type: "text", text: "好的，启动调研。" },
    { type: "toolCall", id: "call_00_x", name: "start_workflow", arguments: { workflowId: "brand-research" } },
  ], api: "openai-completions", provider: "go", model: "m", usage: {}, stopReason: "toolUse", timestamp: 2 } },
  { type: "message", id: "e3", parentId: "e2", timestamp: "2026-08-14T00:00:04.000Z", message: { role: "toolResult", toolCallId: "call_00_x", toolName: "start_workflow", content: [{ type: "text", text: "200 {ok}" }], isError: false, timestamp: 3 } },
  { type: "message", id: "e4", parentId: "e3", timestamp: "2026-08-14T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "已启动。" }], usage: {}, stopReason: "endTurn", timestamp: 4 } },
].map((l) => JSON.stringify(l)).join("\n");

const write = (name: string, content: string): void => writeFileSync(join(DIR, name), content);

describe("pi-session/reader", () => {
  test("完整映射：user/assistant 顺序、blocks 保真、tool_result 归位最近 assistant", () => {
    write("2026-08-14T00-00-00-000Z_chat-c_test.jsonl", FIXTURE);
    const h = readConversationHistory(DIR, "c_test")!;
    expect(h).not.toBeNull();
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);

    expect(h[0].blocks).toEqual([{ kind: "text", text: "帮我调研" }]);
    expect(h[0].content).toBe("帮我调研");

    // assistant e2：thinking/text/tool_use 顺序保真；tool_result 追加在尾
    expect(h[1].blocks).toEqual([
      { kind: "thinking", text: "先想一下" },
      { kind: "text", text: "好的，启动调研。" },
      { kind: "tool_use", toolCallId: "call_00_x", name: "start_workflow", arguments: { workflowId: "brand-research" } },
      { kind: "tool_result", toolCallId: "call_00_x", toolName: "start_workflow", text: "200 {ok}", isError: false },
    ]);
    expect(h[1].content).toBe("好的，启动调研。"); // content=纯 text 拼接（冗余字段）

    expect(h[2].blocks).toEqual([{ kind: "text", text: "已启动。" }]);
    expect(h[1].id).toBe("e2"); // session entry id
  });

  test("user content 裸 string 变体（pi-ai 契约允许）", () => {
    write("t_chat-c_s.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "chat-c_s", timestamp: "t", cwd: "/w" }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "t", message: { role: "user", content: "裸字符串", timestamp: 1 } }),
    ].join("\n"));
    const h = readConversationHistory(DIR, "c_s")!;
    expect(h[0].blocks).toEqual([{ kind: "text", text: "裸字符串" }]);
  });

  test("同 id 多文件 → 取最新 mtime；无关文件不误配", () => {
    write("2026-08-13T00-00-00-000Z_chat-c_old.jsonl", FIXTURE);
    const newer = FIXTURE.replace("帮我调研", "新版内容");
    // 故意旧时间戳名 + 后写（mtime 新）
    write("2026-08-13T00-00-00-000Z_chat-c_dup.jsonl", FIXTURE);
    write("2026-08-14T00-00-00-000Z_chat-c_dup.jsonl", newer);
    const h = readConversationHistory(DIR, "c_dup")!;
    expect(h[0].blocks[0]).toEqual({ kind: "text", text: "新版内容" });
  });

  test("无文件 / 目录不存在 → null（e2e stub 兜底路径）", () => {
    write("x_chat-c_other.jsonl", FIXTURE);
    expect(readConversationHistory(DIR, "c_nope")).toBeNull();
    expect(readConversationHistory(join(DIR, "no-such-dir"), "c_test")).toBeNull();
  });

  test("toolResult 按 toolCallId 对位（晚到也不归错最近 assistant）", () => {
    // e2(toolCall_1) → e3(toolCall_2) → 两条 toolResult 反序到达：
    // 「最近 assistant」策略会把 result_1 归到 e3（错）；按 toolCallId 对位各自归 e2/e3。
    write("t_chat-c_align.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/w" }),
      JSON.stringify({ type: "message", id: "e2", parentId: null, timestamp: "t", message: { role: "assistant", content: [
        { type: "text", text: "先调 A" },
        { type: "toolCall", id: "tc_1", name: "toolA", arguments: {} },
      ], timestamp: 1 } }),
      JSON.stringify({ type: "message", id: "e3", parentId: "e2", timestamp: "t", message: { role: "assistant", content: [
        { type: "text", text: "再调 B" },
        { type: "toolCall", id: "tc_2", name: "toolB", arguments: {} },
      ], timestamp: 2 } }),
      JSON.stringify({ type: "message", id: "e4", parentId: "e3", timestamp: "t", message: { role: "toolResult", toolCallId: "tc_1", toolName: "toolA", content: [{ type: "text", text: "r1" }], isError: false, timestamp: 3 } }),
      JSON.stringify({ type: "message", id: "e5", parentId: "e4", timestamp: "t", message: { role: "toolResult", toolCallId: "tc_2", toolName: "toolB", content: [{ type: "text", text: "r2" }], isError: false, timestamp: 4 } }),
    ].join("\n"));
    const h = readConversationHistory(DIR, "c_align")!;
    expect(h.map((m) => m.blocks.filter((b) => b.kind === "tool_result").length)).toEqual([1, 1]);
    const byId = (m: typeof h[number]) => m.blocks.find((b) => b.kind === "tool_result") as { toolCallId: string; text: string };
    expect([byId(h[0]).toolCallId, byId(h[0]).text]).toEqual(["tc_1", "r1"]);
    expect([byId(h[1]).toolCallId, byId(h[1]).text]).toEqual(["tc_2", "r2"]);
  });

  test("孤儿 toolResult（无前导 assistant）丢弃不炸", () => {
    write("t_chat-c_orphan.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/w" }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "t", message: { role: "toolResult", toolCallId: "c", toolName: "n", content: [{ type: "text", text: "r" }], isError: false, timestamp: 1 } }),
    ].join("\n"));
    expect(readConversationHistory(DIR, "c_orphan")).toEqual([]);
  });

  test("toolResult 对不上任何 toolCallId → 兜底归最近 assistant（不丢数据）", () => {
    write("t_chat-c_fallback.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "t", cwd: "/w" }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 } }),
      JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "t", message: { role: "toolResult", toolCallId: "ghost", toolName: "n", content: [{ type: "text", text: "r" }], isError: false, timestamp: 2 } }),
    ].join("\n"));
    const h = readConversationHistory(DIR, "c_fallback")!;
    expect(h[0].blocks.at(-1)?.kind).toBe("tool_result");
  });
});
