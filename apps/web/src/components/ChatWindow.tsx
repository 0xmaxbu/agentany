// 消息窗（f3-2）：assistant 气泡 = MessageBlocks（text/thinking/tool_use 同构渲染，ADR-0019）。
// run/HITL 卡 ui 组件 + Tailwind；UI 禁 emoji（Phosphor 图标，strokeWidth 1.5）。
// 契约类（e2e）：.chat/.empty/.bubble.{user,assistant,error,aborted}/.content/.cursor/.run/.hitl 不改。
import { useEffect, useRef } from "react";
import { ChatCircleDotsIcon, CheckIcon, PlayIcon, WarningIcon } from "@phosphor-icons/react";
import { useChat } from "../store/chat";
import { MessageBlocks } from "./MessageBlock";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

const IW = 1.5; // 图标线宽全局统一

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
  const sendCardAnswer = useChat((s) => s.sendCardAnswer);
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
              <MessageBlocks blocks={m.blocks} />
            </div>
          ) : (
            <span className="content">{m.blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("")}</span>
          )}
          {m.status === "streaming" && <span className="cursor">▍</span>}
        </div>
      ))}
      {runs.map((r) => (
        <Card key={r.runId} className={`run run-${r.status} my-2 border-border bg-secondary/60 font-mono text-[13px]`}>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 opacity-80">
              <PlayIcon size={13} weight="light" strokeWidth={IW} />
              <span className="truncate">
                {r.workflowId ?? r.runId.slice(0, 10)} · <b>{r.status}</b>
              </span>
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
              <CardTitle className="flex items-start gap-1.5 opacity-85">
                {isApproval ? (
                  <WarningIcon size={15} weight="light" strokeWidth={IW} className="mt-0.5 shrink-0 text-destructive" />
                ) : (
                  <ChatCircleDotsIcon size={15} weight="light" strokeWidth={IW} className="mt-0.5 shrink-0" />
                )}
                <span>
                  {isApproval ? `需审批 · ${q.workflowId ?? ""}` : ""} {q.prompt}
                </span>
              </CardTitle>
            </CardHeader>
            {q.status === "pending" ? (
              <CardContent>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {q.options.map((opt, i) => (
                    // 统一卡应答：所有卡（ask/approval/task）点选项=发消息+inReplyTo 绑定——服务端按 kind 确定性执行。
                    <Button key={i} size="sm" variant="outline" onClick={() => void sendCardAnswer(q.id, opt)}>
                      {opt}
                    </Button>
                  ))}
                </div>
              </CardContent>
            ) : (
              <CardContent>
                <div className="mt-1 flex items-start gap-1 text-emerald-600 dark:text-emerald-400">
                  <CheckIcon size={14} weight="light" strokeWidth={IW} className="mt-0.5 shrink-0" />
                  <span>
                    {isApproval ? "已审批" : "已回答"}：{JSON.stringify(q.answer)}
                  </span>
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
