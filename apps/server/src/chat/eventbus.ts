// per-conversation 事件总线（ticket #13）：事件中心，扇出到持久流（前端展示）+ TurnTrigger（驱动 turn）。
// 单进程内存；无跨进程、无持久化。发布 = 同步调所有订阅者（同 tick 顺序执行）。
// 无订阅者时帧丢弃——故持久流须先连（前端 init 即开流）；重连期丢帧是已知缺口（#19+/序列号再补）。
//
// Frame = 判别式联合（按 type 收窄）—— publish/send 站点类型受检，去 as Frame 与打字错误风险。
// 与 apps/web/src/sse.ts SSEEvent 对齐（线协议）。
export type Frame =
  | { type: "user_message"; id: number; content: string }
  | { type: "done"; messageId?: number; aborted?: boolean }
  // #20 block 三帧：消息=blocks 序列（text/thinking/tool_use/tool_result）；f3 前与 delta/done 双发。
  | { type: "block_start"; blockId: string; kind: "text" | "thinking" | "tool_use" | "tool_result"; meta?: Record<string, unknown> }
  | { type: "block_delta"; blockId: string; delta: string }
  | { type: "block_end"; blockId: string }
  | { type: "error"; message: string }
  | { type: "run_started"; runId: string; workflowId: string }
  | { type: "run_resumed"; runId: string }
  | { type: "run_completed"; runId: string }
  | { type: "run_suspended"; runId: string; stepId: string; payload: unknown; resumeSchema?: unknown }
  | { type: "run_failed"; runId: string; note?: string }
  | { type: "step_started"; runId: string; stepId: string }
  | { type: "step_completed"; runId: string; stepId: string; status: string; output?: unknown; payload?: unknown; resumeSchema?: unknown }
  | { type: "hitl_request"; questionId: number; runId: string | null; prompt: string; options: string[]; resumeSchema?: unknown; multiple?: number; kind?: "ask" | "approval"; workflowId?: string }
  | { type: "hitl_answered"; questionId: number; answer: unknown; kind?: "ask" | "approval"; runId?: string };
export type FrameHandler = (f: Frame) => void;

export class EventBus {
  private subs = new Map<string, Set<FrameHandler>>();

  /** 订阅某会话帧，返回取消订阅。 */
  subscribe(conversationId: string, fn: FrameHandler): () => void {
    let set = this.subs.get(conversationId);
    if (!set) {
      set = new Set();
      this.subs.set(conversationId, set);
    }
    set.add(fn);
    return () => {
      const s = this.subs.get(conversationId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subs.delete(conversationId);
    };
  }

  /** 发布帧到某会话所有订阅者（同步扇出）。无订阅者 → 丢弃。 */
  publish(conversationId: string, frame: Frame): void {
    const set = this.subs.get(conversationId);
    if (!set) return;
    for (const fn of set) fn(frame);
  }
}
