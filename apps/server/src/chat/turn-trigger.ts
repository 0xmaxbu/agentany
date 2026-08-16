// TurnTrigger（ticket #13/#15）：把「触发」映射成「turn 入队」，是所有 turn 的统一调度入口。
// - 拓扑：EventBus 扇出 → TurnTrigger（attach 订阅帧）+ 持久流（展示）。
//   · user_message → HTTP turn（POST 同步 429 预检，#13）
//   · run_completed/suspended/failed → 事件 turn（enqueueEventTurn，非空事件 prompt，#15）
//   · run_started → 记 runId→workflowId（供 run_* 事件 prompt 用）；step_*/run_resumed → 忽略（只推流，防风暴）
// - 事件 turn 复用 runTurn（同一 pi session chat-<convId>），输出 delta 经 EventBus 推持久流。
import type { RunDeps } from "../runs";
import { runTurn } from "./turn";
import type { ConversationQueues } from "./queue";
import type { EventBus, Frame } from "./eventbus";

// run_* 边界事件子集（onRunEvent/eventPrompt 收窄用——这三型都有 runId）。
type RunBoundaryFrame =
  | Extract<Frame, { type: "run_completed" }>
  | Extract<Frame, { type: "run_suspended" }>
  | Extract<Frame, { type: "run_failed" }>;

interface TurnTriggerDeps {
  deps: RunDeps;
  queues: ConversationQueues;
  eventBus: EventBus;
}

export class TurnTrigger {
  private attached = new Set<string>();
  private runWorkflow = new Map<string, string>(); // runId → workflowId（run_started 记，供 run_* 事件 prompt 用）
  constructor(private d: TurnTriggerDeps) {}

  /** 订阅会话帧 → 调度 turn（user_message→HTTP；run_*→事件）。建会话时调，幂等。 */
  attach(conversationId: string): void {
    if (this.attached.has(conversationId)) return; // 幂等：防重复订阅→重复起 turn
    this.attached.add(conversationId);
    this.d.eventBus.subscribe(conversationId, (f) => this.onFrame(conversationId, f));
  }

  private onFrame(conversationId: string, f: Frame): void {
    switch (f.type) {
      case "user_message":
        // #29 定时任务投递的 prompt 帧带 taskId：executeTask 已自起 event turn（TASK_EXTENSIONS 无 bridge），
        // 再起 HTTP turn（CHAT_EXTENSIONS 含 bridge）会同 prompt 双跑 + 交互工具泄漏——跳过（review-c1）。
        if (f.type === "user_message" && f.taskId !== undefined) break;
        this.onUserMessage(conversationId, String(f.content));
        break;
      case "run_started":
        this.runWorkflow.set(String(f.runId), String(f.workflowId)); // 只记录，不触发 turn（run_started 仅推流展示）
        break;
      case "run_completed":
      case "run_suspended":
      case "run_failed":
        this.onRunEvent(conversationId, f);
        break;
      default:
        break; // step_*/run_resumed → 忽略（只推流，防事件风暴）
    }
  }

  /** 起 HTTP turn：入 FIFO（串行 pi session）。满 → 发 error 帧（前端回滚）+ 返 false。 */
  onUserMessage(conversationId: string, content: string): boolean {
    const ok = this.d.queues.enqueueHttpTurn(conversationId, (signal) => {
      const send = (fr: Frame) => this.d.eventBus.publish(conversationId, fr);
      return runTurn(this.d.deps, conversationId, content, send, signal);
    });
    if (!ok) this.d.eventBus.publish(conversationId, { type: "error", message: "conversation busy (queue full)" });
    return ok;
  }

  /** run_* 边界事件 → 事件 turn（enqueueEventTurn，非空事件 prompt）。cap 满 → 静默丢弃（防风暴，v1）。 */
  private onRunEvent(conversationId: string, f: RunBoundaryFrame): void {
    const runId = f.runId;
    const workflowId = this.runWorkflow.get(runId) ?? this.d.deps.store.getRun(runId)?.workflowId ?? "?";
    const prompt = this.eventPrompt(f, runId, workflowId);
    this.d.queues.enqueueEventTurn(conversationId, (signal) => {
      const send = (fr: Frame) => this.d.eventBus.publish(conversationId, fr);
      return runTurn(this.d.deps, conversationId, prompt, send, signal);
    });
  }

  // 事件 turn 的非空 prompt 模板（#15）。suspended/failed 不提 resume_workflow/ask_user（#16 才有工具）。
  private eventPrompt(f: RunBoundaryFrame, runId: string, workflowId: string): string {
    if (f.type === "run_completed") {
      const log = this.d.deps.store.getLog(runId);
      const summary = log.map((e) => `${e.stepId}(${e.status})`).join(", ") || "（无步骤日志）";
      return `[系统事件] 工作流 "${workflowId}"(${runId}) 已完成。日志摘要：${summary}。可用 read_run 查看详情。请向用户总结。`;
    }
    if (f.type === "run_suspended") {
      return `[系统事件] 工作流 "${workflowId}"(${runId}) 步骤 "${String(f.stepId)}" 挂起待决策。上下文：${JSON.stringify(f.payload)} 续跑契约：${JSON.stringify(f.resumeSchema)}。请向用户说明挂起情况并询问如何决策。`;
    }
    return `[系统事件] 工作流 "${workflowId}"(${runId}) 失败：${f.note ?? "未知错误"}。请告知用户。`;
  }
}
