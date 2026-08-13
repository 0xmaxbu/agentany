import { useEffect } from "react";
import { useChat } from "./store";
import { ChatWindow } from "./components/ChatWindow";
import { Composer } from "./components/Composer";
import { ConversationList } from "./components/ConversationList";

export function App() {
  const init = useChat((s) => s.init);
  const conversationId = useChat((s) => s.conversationId);
  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="app">
      <ConversationList />
      <div className="main">
        <header>
          <h1>agentany</h1>
          <span className="conv">{conversationId ? `会话 ${conversationId.slice(-6)}` : "准备中…"}</span>
        </header>
        <ChatWindow />
        <Composer />
      </div>
    </div>
  );
}
