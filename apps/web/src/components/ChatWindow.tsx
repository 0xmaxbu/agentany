// 消息窗（f2-4）：assistant 气泡 react-markdown+remark-gfm（删手搓 markdown.ts，无 dangerouslySetInnerHTML）；
// run/HITL 卡换 ui 组件 + Tailwind（暗色适配——旧 inline 硬编码色双主题下是错的）。
// 契约类（e2e）：.chat/.empty/.bubble.{user,assistant,error,aborted}/.content/.cursor/.run/.hitl 不改。
import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChat } from "../store/chat";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

// step 状态色（语义变量驱动，双主题自适应）
const stepClass = (status: string): string =>
  status === "completed"
    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
    : status === "failed"
      ? "bg-destructive/15 text-destructive"
      : "bg-primary/15 text-primary";

export function ChatWindow() {
  const messages = useChat((s) => s.messages);
  const runs = useChat((s) => s.runs);
  const questions = useChat((s) => s.questions);
  const send = useChat((s) => s.send);
  const decideApproval = useChat((s) => s.decideApproval);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, runs, questions]);

  return (
    <main className="chat">
      {messages.length === 0 && runs.length === 0 && questions.length === 0 && (
        <div className="empty">发条消息开始对话</div>
      )}
      {messages.map((m, i) => (
        <div key={i} className={`bubble ${m.role} ${m.status}`}>
          {m.role === "assistant" ? (
            <div className="content md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
            </div>
          ) : (
            <span className="content">{m.content}</span>
          )}
          {m.status === "streaming" && <span className="cursor">▍</span>}
        </div>
      ))}
      {runs.map((r) => (
        <Card key={r.runId} className={`run run-${r.status} my-2 border-border bg-secondary/60 font-mono text-[13px]`}>
          <CardHeader>
            <CardTitle className="opacity-80">
              ⚙️ {r.workflowId ?? r.runId.slice(0, 10)} · <b>{r.status}</b>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {r.steps.map((st, i) => (
                <span key={i} title={st.status} className={`rounded px-1.5 py-0.5 text-xs ${stepClass(st.status)}`}>
                  {st.stepId}
                </span>
              ))}
            </div>
            {r.note && <div className="mt-1 text-destructive">{r.note}</div>}
          </CardContent>
        </Card>
      ))}
      {questions.map((q) => {
        const isApproval = q.kind === "approval";
        return (
          <Card
            key={`q-${q.id}`}
            className={`hitl hitl-${q.kind} hitl-${q.status} my-2 text-[13px] ${
              q.status === "answered" ? "bg-muted/60" : isApproval ? "bg-destructive/5" : "bg-amber-500/5"
            }`}
          >
            <CardHeader>
              <CardTitle className="flex items-start gap-1 opacity-85">
                <span>{isApproval ? "⚠️" : "❓"}</span>
                <span>
                  {isApproval ? `需审批 · ${q.workflowId ?? ""}` : ""} {q.prompt}
                </span>
              </CardTitle>
            </CardHeader>
            {q.status === "pending" ? (
              <CardContent>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {isApproval ? (
                    // 审批：动作固定 approve/deny（不靠选项文本反推——options 仅作标签，去字符串耦合）。
                    // 契约：registry 建审批卡 options=["批准","拒绝"]（index 0=approve, 1=deny）。
                    <>
                      <Button size="sm" variant="outline" onClick={() => decideApproval(q.id, "approve")}>
                        {q.options[0] ?? "批准"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => decideApproval(q.id, "deny")}>
                        {q.options[1] ?? "拒绝"}
                      </Button>
                    </>
                  ) : (
                    q.options.map((opt, i) => (
                      <Button key={i} size="sm" variant="outline" onClick={() => void send(opt)}>
                        {opt}
                      </Button>
                    ))
                  )}
                </div>
              </CardContent>
            ) : (
              <CardContent>
                <div className="mt-1 text-emerald-600 dark:text-emerald-400">
                  ✓ {isApproval ? "已审批" : "已回答"}：{JSON.stringify(q.answer)}
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}
      <div ref={endRef} />
    </main>
  );
}
