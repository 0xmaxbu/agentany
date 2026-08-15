// SSE wire-format parser（ADR-0009 BE-Q4 / ticket #13 持久流）：单通道 JSON-`type`。纯函数、可单测。
// 与「字节怎么到」（fetch+ReadableStream）解耦——本文件只管「块什么意思」。
import { BLOCK_FRAME, type BlockKind } from "./lib/blocks";
export { type Block, type BlockKind } from "./lib/blocks";

export type SSEEvent =
  | { type: "user_message"; id: number; content: string }
  // f3/ADR-0019 块三帧：blockId 标识块（非 turn）；turn 边界仍由 done 表达
  | { type: typeof BLOCK_FRAME.start; blockId: string; kind: BlockKind; meta?: Record<string, unknown> }
  | { type: typeof BLOCK_FRAME.delta; blockId: string; delta: string }
  | { type: typeof BLOCK_FRAME.end; blockId: string }
  | { type: "done"; messageId?: number; aborted?: boolean }
  | { type: "error"; message: string }
  // ticket #14：工作流 run 两级事件（持久流承载，前端做基础进度渲染）
  | { type: "run_started"; runId: string; workflowId: string }
  | { type: "run_resumed"; runId: string }
  | { type: "run_completed"; runId: string }
  | { type: "run_suspended"; runId: string; stepId: string; payload: unknown; resumeSchema?: unknown }
  | { type: "run_failed"; runId: string; note?: string }
  | { type: "step_started"; runId: string; stepId: string }
  | { type: "step_completed"; runId: string; stepId: string; status: string; output?: unknown; payload?: unknown; resumeSchema?: unknown }
  // ticket #16 ask_user（kind=ask）+ #18 审批门（kind=approval）：异步发卡 + 用户答→续跑/审批
  | { type: "hitl_request"; questionId: number; runId: string | null; kind?: "ask" | "approval"; workflowId?: string; prompt: string; options: string[]; resumeSchema?: unknown; multiple?: number }
  | { type: "hitl_answered"; questionId: number; kind?: "ask" | "approval"; runId?: string; answer: unknown };

/**
 * 从缓冲区解析完整 SSE 帧（按 `\n\n` 分隔），返回解析出的事件 + 剩余不完整片段。
 * 每帧多行：`data:` 开头的行按 SSE 规范拼为 data；注释行（`:` 开头，如 `: ping`）及其它行忽略。
 * data 非合法 JSON 或缺 `type` 的帧忽略（fail-soft）。
 */
export function parseSSEFrames(buf: string): { events: SSEEvent[]; rest: string } {
  const events: SSEEvent[] = [];
  let rest = buf;
  while (true) {
    const i = rest.indexOf("\n\n");
    if (i === -1) break;
    const frame = rest.slice(0, i);
    rest = rest.slice(i + 2);
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) continue; // 注释/空帧
    try {
      const ev = JSON.parse(dataLines.join("\n")) as SSEEvent;
      if (ev && typeof (ev as any).type === "string") events.push(ev);
    } catch {
      /* 非 JSON 帧：忽略 */
    }
  }
  return { events, rest };
}
