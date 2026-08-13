import { useState } from "react";
import { useChat } from "../store";

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
        <button className="stop" onClick={() => void stop()}>停止</button>
      ) : (
        <button onClick={() => void submit()} disabled={!text.trim()}>发送</button>
      )}
    </footer>
  );
}
