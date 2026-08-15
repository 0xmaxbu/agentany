// Chat 主页（f2-3）：URL /c/:id 唯一真相——**单向** URL→store（params effect 驱动 switch/new）。
// 教训（请求风暴事故）：store→URL 反向跟随 effect 会与 URL→store 振荡（每轮各发 GET messages，
// 实测 ~2500 req/s）——切换/新建一律由调用方 navigate，本组件永不反向写 URL。
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { useChat } from "../store/chat";
import { ChatWindow } from "../components/ChatWindow";
import { Composer } from "../components/Composer";
import { useShellControls } from "./ShellLayout";

export function ChatPage() {
  const conversationId = useChat((s) => s.conversationId);
  const switchConversation = useChat((s) => s.switchConversation);
  const newConversation = useChat((s) => s.newConversation);
  const params = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    const target = params.conversationId;
    if (target) {
      void switchConversation(target); // 幂等（同 id return）
      return;
    }
    // index = 新会话入口（不选 list[0]：会话列表是服务端共享真相，复用首条会落到
    // 别处留下的会话上；「/ → 一律新建」对齐 localStorage 时代语义，reload 恢复走 URL :id）
    void newConversation().then((id) => {
      if (id) navigate(`/c/${id}`, { replace: true });
    });
  }, [params.conversationId, switchConversation, newConversation, navigate]);

  const controls = useShellControls();

  return (
    <div className="main flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <h1 className="text-base font-semibold">agentany</h1>
        <div className="flex items-center gap-3">
          <span className="conv text-xs text-muted-foreground">{conversationId ? `会话 ${conversationId.slice(-6)}` : "准备中…"}</span>
          {controls}
        </div>
      </header>
      <ChatWindow />
      <Composer />
    </div>
  );
}
