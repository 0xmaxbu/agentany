// 输入区（f2-4 接 ui/Button）：契约——全局唯一 textarea、button.stop 类名（e2e）。
// #21：归档会话禁发（前端禁用 + 后端 409 双保险）。
import { useState } from "react";
import { useChat } from "../store/chat";
import { useWorkspace } from "../store/workspace";
import { Button } from "./ui/button";

export function Composer() {
  const [text, setText] = useState("");
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const sending = useChat((s) => s.sending);
  const conversationId = useChat((s) => s.conversationId);
  // 归档态（#21）：当前会话在归档列表中（主列表已下架，活跃列表查不到即以归档列表为准）。
  const archived = useWorkspace((s) => s.archivedConversations.some((c) => c.id === conversationId));

  const submit = async () => {
    const c = text.trim();
    if (!c || sending) return;
    setText("");
    await send(c);
  };

  if (archived) {
    return (
      <footer className="composer">
        <textarea disabled rows={2} placeholder="已归档，恢复后可继续对话" />
      </footer>
    );
  }

  return (
    <footer className="composer">
      <textarea
        value={text}
        placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        rows={2}
      />
      {sending ? (
        <Button variant="destructive" className="stop" onClick={() => void stop()}>
          停止
        </Button>
      ) : (
        <Button onClick={() => void submit()} disabled={!text.trim()}>
          发送
        </Button>
      )}
    </footer>
  );
}
