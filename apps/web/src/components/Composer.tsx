// 输入区（f2-4 接 ui/Button）：契约——全局唯一 textarea、button.stop 类名（e2e）。
import { useState } from "react";
import { useChat } from "../store/chat";
import { Button } from "./ui/button";

export function Composer() {
  const [text, setText] = useState("");
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const sending = useChat((s) => s.sending);

  const submit = async () => {
    const c = text.trim();
    if (!c || sending) return;
    setText("");
    await send(c);
  };

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
