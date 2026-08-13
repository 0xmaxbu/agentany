import { useEffect, useRef } from "react";
import { useChat } from "../store";
import { renderMarkdown } from "../markdown";

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
            <div className="content md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
          ) : (
            <span className="content">{m.content}</span>
          )}
          {m.status === "streaming" && <span className="cursor">▍</span>}
        </div>
      ))}
      {runs.map((r) => (
        <div
          key={r.runId}
          className={`run run-${r.status}`}
          style={{
            margin: "8px 0", padding: "8px 10px", border: "1px solid #e3e3e3", borderRadius: 8,
            background: "#fafafa", fontSize: 13, fontFamily: "ui-monospace, monospace",
          }}
        >
          <div style={{ opacity: 0.8 }}>
            ⚙️ {r.workflowId ?? r.runId.slice(0, 10)} · <b>{r.status}</b>
          </div>
          <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {r.steps.map((st, i) => (
              <span
                key={i}
                title={st.status}
                style={{
                  padding: "1px 6px", borderRadius: 4,
                  background: st.status === "completed" ? "#e6f4ea" : st.status === "failed" ? "#fce8e6" : "#e8f0fe",
                  color: st.status === "completed" ? "#137333" : st.status === "failed" ? "#c5221f" : "#174ea6",
                }}
              >
                {st.stepId}
              </span>
            ))}
          </div>
          {r.note && <div style={{ marginTop: 4, color: "#c5221f" }}>{r.note}</div>}
        </div>
      ))}
      {questions.map((q) => {
        const isApproval = q.kind === "approval";
        return (
          <div
            key={`q-${q.id}`}
            className={`hitl hitl-${q.kind} hitl-${q.status}`}
            style={{
              margin: "8px 0", padding: "8px 10px", border: "1px solid #e3e3e3", borderRadius: 8,
              background: q.status === "answered" ? "#f6f8fa" : isApproval ? "#fff5f5" : "#fffbeb", fontSize: 13,
            }}
          >
            <div style={{ opacity: 0.85 }}>
              {isApproval ? `⚠️ 需审批 · ${q.workflowId ?? ""}` : "❓"} {q.prompt}
            </div>
            {q.status === "pending" ? (
              <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {isApproval ? (
                  // 审批：动作固定 approve/deny（不靠选项文本反推——options 仅作标签，去字符串耦合）。
                  // 契约：registry 建审批卡 options=["批准","拒绝"]（index 0=approve, 1=deny）。
                  <>
                    <button key="approve" onClick={() => decideApproval(q.id, "approve")} style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid #d0d7de", background: "#fff", cursor: "pointer", fontSize: 13 }}>{q.options[0] ?? "批准"}</button>
                    <button key="deny" onClick={() => decideApproval(q.id, "deny")} style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid #d0d7de", background: "#fff", cursor: "pointer", fontSize: 13 }}>{q.options[1] ?? "拒绝"}</button>
                  </>
                ) : (
                  q.options.map((opt, i) => (
                    <button
                      key={i}
                      onClick={() => send(opt)}
                      style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid #d0d7de", background: "#fff", cursor: "pointer", fontSize: 13 }}
                    >
                      {opt}
                    </button>
                  ))
                )}
              </div>
            ) : (
              <div style={{ marginTop: 4, color: "#137333" }}>
                ✓ {isApproval ? "已审批" : "已回答"}：{JSON.stringify(q.answer)}
              </div>
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </main>
  );
}
