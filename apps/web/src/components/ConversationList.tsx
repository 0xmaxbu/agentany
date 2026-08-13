import { useChat } from "../store";

// 会话列表（客户端 localStorage 跟踪）。+新会话 / 点切换（各自独立 Pi 会话）。
export function ConversationList() {
  const conversations = useChat((s) => s.conversations);
  const current = useChat((s) => s.conversationId);
  const newConversation = useChat((s) => s.newConversation);
  const switchConversation = useChat((s) => s.switchConversation);

  return (
    <aside className="conv-list">
      <button className="new" onClick={() => void newConversation()}>
        + 新会话
      </button>
      {conversations.map((c) => (
        <button
          key={c.id}
          className={c.id === current ? "item active" : "item"}
          onClick={() => void switchConversation(c.id)}
        >
          {c.title || `会话 ${c.id.slice(-6)}`}
        </button>
      ))}
    </aside>
  );
}
