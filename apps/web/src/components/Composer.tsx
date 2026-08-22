// 输入区（f2-4 接 ui/Button；chat-optimize 卡片式）：契约——全局唯一 textarea、button.stop 类名（e2e）。
// #21：归档会话禁发（前端禁用 + 后端 409 双保险）。
import { useState } from "react";
import { PaperPlaneTiltIcon, StopIcon } from "@phosphor-icons/react";
import { useChat } from "../store/chat";
import { useWorkspace } from "../store/workspace";
import { Button } from "./ui/button";

const IW = 1.5; // 图标线宽全局统一

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

  return (
    <footer className="composer shrink-0 px-4 pb-4 pt-1">
      {/* 卡片式输入（chat-optimize）：外框即焦点态容器——focus-within 描边，textarea 本体无框 */}
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-xl border border-input bg-card p-2 pl-3.5 shadow-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
        <textarea
          value={text}
          placeholder={archived ? "已归档，恢复后可继续对话" : "输入消息…（Enter 发送，Shift+Enter 换行）"}
          disabled={archived}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          className="max-h-40 min-h-11 flex-1 resize-none self-stretch bg-transparent py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        />
        {sending ? (
          <Button
            variant="destructive"
            size="icon"
            className="stop shrink-0 rounded-lg"
            onClick={() => void stop()}
            aria-label="停止生成"
            title="停止"
          >
            <StopIcon size={16} weight="fill" strokeWidth={IW} />
          </Button>
        ) : (
          <Button
            size="icon"
            className="shrink-0 rounded-lg"
            onClick={() => void submit()}
            disabled={!text.trim()}
            aria-label="发送消息"
            title="发送"
          >
            <PaperPlaneTiltIcon size={16} weight="fill" strokeWidth={IW} />
          </Button>
        )}
      </div>
    </footer>
  );
}
