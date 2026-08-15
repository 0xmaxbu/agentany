// f3-1 blocks 组装状态机（store/chat onFrame block_* 三帧）：TDD 先行。
// 隐式跟随（block_start 无 streaming → 开新 assistant 消息）、孤儿容错（丢弃+warn）、
// tool_result 按 toolCallId 归属到 tool_use（渲染层折卡用）、done 落定。
import { describe, test, expect, beforeEach } from "bun:test";
import { useChat, type UIAnyBlock } from "../src/store/chat";

// 直推帧到 onFrame（绕过网络层——状态机纯逻辑）
const push = (ev: unknown) => useChat.getState().onFrame(ev as never);

const reset = () => {
  useChat.setState({ messages: [], sending: true, conversationId: "c_test", runs: [], questions: [] });
};

describe("blocks 组装状态机", () => {
  beforeEach(reset);

  test("user_message + text 三帧 → user 气泡 + assistant blocks 消息（隐式跟随开新消息）", () => {
    push({ type: "user_message", id: 1, content: "hi" });
    push({ type: "block_start", blockId: "b1", kind: "text" });
    push({ type: "block_delta", blockId: "b1", delta: "你" });
    push({ type: "block_delta", blockId: "b1", delta: "好" });
    push({ type: "block_end", blockId: "b1" });
    push({ type: "done", messageId: 9 });

    const msgs = useChat.getState().messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ id: 1, role: "user", blocks: [{ kind: "text", text: "hi" }], status: "complete" });
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].status).toBe("complete");
    expect(msgs[1].blocks).toEqual([{ kind: "text", blockId: "b1", text: "你好" }]); // blockId 保留（React key 稳定标识）
    expect(useChat.getState().sending).toBe(false);
  });

  test("thinking→text 交替：两 block 同一消息内顺序追加", () => {
    push({ type: "block_start", blockId: "b1", kind: "thinking" });
    push({ type: "block_delta", blockId: "b1", delta: "想想" });
    push({ type: "block_end", blockId: "b1" });
    push({ type: "block_start", blockId: "b2", kind: "text" });
    push({ type: "block_delta", blockId: "b2", delta: "答" });
    push({ type: "block_end", blockId: "b2" });

    const msgs = useChat.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks).toEqual([
      { kind: "thinking", blockId: "b1", text: "想想" }, // 终态：streaming 已清；blockId 保留（React key）
      { kind: "text", blockId: "b2", text: "答" },
    ]);
  });

  test("tool_use（start 带 meta 即完整）+ tool_result 按 toolCallId 归属", () => {
    push({ type: "block_start", blockId: "tc_1", kind: "tool_use", meta: { toolCallId: "tc_1", name: "read", arguments: { path: "a.ts" } } });
    push({ type: "block_end", blockId: "tc_1" });
    push({ type: "block_start", blockId: "r_tc_1", kind: "tool_result", meta: { toolCallId: "tc_1", toolName: "read", isError: false } });
    push({ type: "block_delta", blockId: "r_tc_1", delta: "文件内容" });
    push({ type: "block_end", blockId: "r_tc_1" });

    const msgs = useChat.getState().messages;
    expect(msgs).toHaveLength(1);
    const use = msgs[0].blocks.find((b: UIAnyBlock) => b.kind === "tool_use") as Extract<UIAnyBlock, { kind: "tool_use" }>;
    expect(use.name).toBe("read");
    // tool_result 折进 tool_use 卡：block 上有 result 字段
    expect((use as { result?: { text: string; isError: boolean } }).result).toEqual({ text: "文件内容", isError: false });
    // tool_result 不单独占一个 block 位
    expect(msgs[0].blocks.filter((b: UIAnyBlock) => b.kind === "tool_result")).toHaveLength(0);
  });

  test("孤儿帧（无 start 的 delta/end）静默丢弃不炸", () => {
    push({ type: "block_delta", blockId: "ghost", delta: "x" });
    push({ type: "block_end", blockId: "ghost" });
    expect(useChat.getState().messages).toHaveLength(0);
  });

  test("孤儿 tool_result（tool_use 不在）丢弃", () => {
    push({ type: "block_start", blockId: "r_x", kind: "tool_result", meta: { toolCallId: "nope", toolName: "read", isError: false } });
    push({ type: "block_end", blockId: "r_x" });
    expect(useChat.getState().messages).toHaveLength(0);
  });

  test("孤儿 tool_result 复用已有 streaming 消息时不误删该消息（只撤销自开的）", () => {
    // 场景：末条 streaming assistant（已有 text 块流式中）→ 来一条孤儿 tool_result
    push({ type: "block_start", blockId: "b1", kind: "text" });
    push({ type: "block_delta", blockId: "b1", delta: "流式中" });
    push({ type: "block_start", blockId: "r_ghost", kind: "tool_result", meta: { toolCallId: "nope", toolName: "read", isError: false } });
    const msgs = useChat.getState().messages;
    expect(msgs).toHaveLength(1); // 原 streaming 消息仍在
    expect(msgs[0].blocks.map((b: UIAnyBlock) => b.kind)).toEqual(["text"]); // 孤儿块未落入
    expect(msgs[0].status).toBe("streaming");
  });

  test("跨消息归属：tool_use 在上一消息（已 complete）→ tool_result 折进上一消息的卡", () => {
    // turn1：tool_use + done 落定
    push({ type: "block_start", blockId: "t1", kind: "tool_use", meta: { toolCallId: "t1", name: "read", arguments: {} } });
    push({ type: "block_end", blockId: "t1" });
    push({ type: "done", messageId: 1 });
    // turn2：新消息流式中，tool_result 到达（owner 在上一消息）
    push({ type: "block_start", blockId: "b1", kind: "text" });
    push({ type: "block_delta", blockId: "b1", delta: "继续" });
    push({ type: "block_start", blockId: "r_t1", kind: "tool_result", meta: { toolCallId: "t1", toolName: "read", isError: false } });
    push({ type: "block_delta", blockId: "r_t1", delta: "结果" });
    push({ type: "block_end", blockId: "r_t1" });

    const msgs = useChat.getState().messages;
    expect(msgs).toHaveLength(2);
    const owner = msgs[0].blocks[0] as Extract<UIAnyBlock, { kind: "tool_use" }>;
    expect(owner.result).toEqual({ text: "结果", isError: false }); // 折进上一消息的卡
    expect(msgs[1].blocks.map((b: UIAnyBlock) => b.kind)).toEqual(["text"]); // 本消息无残留 result 块
  });

  test("done.aborted → 末条 assistant 标 aborted；error → 回滚 user+assistant 出 error 气泡", () => {
    push({ type: "user_message", id: 1, content: "boom" });
    push({ type: "block_start", blockId: "b1", kind: "text" });
    push({ type: "block_delta", blockId: "b1", delta: "partial" });
    push({ type: "done", aborted: true });
    expect(useChat.getState().messages.at(-1)?.status).toBe("aborted");
  });

  test("error 帧 → 回滚本轮 user+assistant、error 气泡", () => {
    push({ type: "user_message", id: 1, content: "boom" });
    push({ type: "block_start", blockId: "b1", kind: "text" });
    push({ type: "block_delta", blockId: "b1", delta: "partial" });
    push({ type: "error", message: "炸了" });
    const msgs = useChat.getState().messages;
    expect(msgs.at(-1)?.status).toBe("error");
    expect(msgs).toHaveLength(1); // user + streaming assistant 回滚，剩 error 一条
  });
});
