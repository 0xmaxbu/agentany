// 右栏上下文（f2-3 最小版）：会话元信息 + 挂起 HITL 摘要。默认收起（header 钮切换）；重内容 v2。
import { useChat } from "../store/chat";

export function ContextPanel() {
  const conversationId = useChat((s) => s.conversationId);
  const questions = useChat((s) => s.questions);
  const pending = questions.filter((q) => q.status === "pending");

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-background p-4">
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">会话</h2>
        <p className="mt-1 break-all font-mono text-xs text-foreground">{conversationId ?? "-"}</p>
      </div>
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">待处理</h2>
        {pending.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">无挂起提问</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {pending.map((q) => (
              <li key={q.id} className="rounded-sm bg-secondary px-2 py-1 text-xs text-foreground">
                {q.kind === "approval" ? "审批" : "提问"}：{q.prompt}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
