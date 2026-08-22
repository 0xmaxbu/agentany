// 消息窗（f3-2）：assistant = MessageBlocks 全宽渲染（chat-optimize 内容优先——无气泡，ADR-0016 调性）。
// run/HITL 卡 ui 组件 + Tailwind；UI 禁 emoji（Phosphor 图标，strokeWidth 1.5）。
// 契约类（e2e）：.chat/.empty/.bubble.{user,assistant,error,aborted}/.content/.cursor/.run/.hitl 不改。
import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatCircleDotsIcon, CheckIcon, PlayIcon, WarningIcon } from "@phosphor-icons/react";
import { useChat } from "../store/chat";
import { MessageBlocks } from "./MessageBlock";
import { FileListCard, groupForMessage } from "./FileListCard";
import { MessageFeedback, RunFeedback } from "./FeedbackControls";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

const IW = 1.5; // 图标线宽全局统一

// ADR-0025 决策 10 修订：回答上卡——字符串答案（点选文本/pi 归一化）原样显示，对象答案 JSON 兜底（resumeData 等）
const fmtAnswer = (a: unknown): string => (typeof a === "string" ? a : JSON.stringify(a));

// step 状态色（语义变量驱动，双主题自适应）
const stepClass = (status: string): string =>
  status === "completed"
    ? "bg-success/15 text-success"
    : status === "failed"
      ? "bg-destructive/15 text-destructive"
      : "bg-primary/15 text-primary";

export function ChatWindow() {
  const messages = useChat((s) => s.messages);
  const runs = useChat((s) => s.runs);
  const questions = useChat((s) => s.questions);
  const fileGroups = useChat((s) => s.fileGroups);
  const workspaceId = useChat((s) => s.workspaceId);
  const sendCardAnswer = useChat((s) => s.sendCardAnswer);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, runs, questions]);

  return (
    <main className="chat">
      {/* 内容列（line-length 纪律）：消息/卡统一 max-w-3xl 居中，与 Composer 卡片同宽 */}
      <div className="mx-auto w-full max-w-3xl">
        {messages.length === 0 && runs.length === 0 && questions.length === 0 && (
          <div className="empty flex flex-col items-center gap-2 pt-24">
            <ChatCircleDotsIcon size={44} weight="light" strokeWidth={IW} className="text-muted-foreground opacity-50" />
            <p className="text-sm">发条消息开始对话</p>
            <p className="text-xs opacity-70">Enter 发送 · Shift+Enter 换行</p>
          </div>
        )}
        {messages.map((m, i) => {
          // #30 产出文件列表卡：锚在对应产出消息（outputMessageId）尾——文件管理器式列表
          const fileGroup = groupForMessage(fileGroups, m.id);
          return (
            <div key={m.id ?? `m${i}`}>
              <div className={`bubble ${m.role} ${m.status}`}>
                {m.role === "assistant" ? (
                  <div className="content md">
                    <MessageBlocks blocks={m.blocks} />
                  </div>
                ) : (
                  <span className="content">{m.blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("")}</span>
                )}
                {m.status === "streaming" && <span className="cursor">▍</span>}
              </div>
              {m.role === "assistant" && m.status !== "streaming" && m.id != null && (
                <div className="mb-5 -mt-1">
                  <MessageFeedback messageId={m.id} />
                </div>
              )}
              {fileGroup && workspaceId && (
                <div className="bubble assistant">
                  <FileListCard group={fileGroup} workspaceId={workspaceId} />
                </div>
              )}
            </div>
          );
        })}
        {runs.map((r) => (
          <Card key={r.runId} className={`run run-${r.status} my-2 border-border bg-secondary/60 font-mono text-[13px]`}>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5 text-muted-foreground">
                <PlayIcon size={14} weight="light" strokeWidth={IW} />
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
              <RunFeedback runId={r.runId} />
            </CardContent>
          </Card>
        ))}
        {questions.map((q) => {
          const isApproval = q.kind === "approval";
          return (
            <Card
              key={`q-${q.id}`}
              className={`hitl hitl-${q.kind} hitl-${q.status} my-2 text-[13px] ${
                q.status === "answered" ? "bg-muted/60" : isApproval ? "bg-destructive/5" : "bg-warning/5"
              }`}
            >
              <CardHeader>
                <CardTitle className="flex items-start gap-1.5 text-muted-foreground">
                  {isApproval ? (
                    <WarningIcon size={14} weight="light" strokeWidth={IW} className="mt-0.5 shrink-0 text-destructive" />
                  ) : (
                    <ChatCircleDotsIcon size={14} weight="light" strokeWidth={IW} className="mt-0.5 shrink-0" />
                  )}
                  <span className="text-foreground">
                    {isApproval ? `需审批 · ${q.workflowId ?? ""}` : ""} {q.prompt}
                  </span>
                </CardTitle>
              </CardHeader>
              {q.status === "pending" ? (
                <CardContent>
                  {q.context && (
                    // ADR-0025 决策 5：决策辅助 markdown（候选对比/产出摘要——用户决策依据）
                    <div className="md mb-2 text-xs text-muted-foreground">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{q.context}</ReactMarkdown>
                    </div>
                  )}
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
                  <div className="mt-1 flex items-start gap-1 text-success">
                    <CheckIcon size={14} weight="light" strokeWidth={IW} className="mt-0.5 shrink-0" />
                    <span>
                      {isApproval ? "已审批" : "已回答"}：{fmtAnswer(q.answer)}
                    </span>
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
      <div ref={endRef} />
    </main>
  );
}
