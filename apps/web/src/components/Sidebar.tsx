// 左栏（f2-3 三区之一）：品牌 + 用户区 + 新会话 + 会话列表按 ws 分组。
// 契约类（e2e）：aside.conv-list / button.new / button.item——顺序 = updatedAt 倒序（组内）。
// 切换/新建直接 navigate（URL 唯一真相——ChatPage params effect 单向驱动 store）。
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useWorkspace } from "../store/workspace";
import { useChat } from "../store/chat";
import { useAuth } from "../store/auth";
import { groupByWorkspace } from "../lib/group";

export function Sidebar() {
  // 订阅原始数组（引用稳定），useMemo 算分组——selector 里调函数返回新数组会致无限重渲染。
  const workspaces = useWorkspace((s) => s.workspaces);
  const conversations = useWorkspace((s) => s.conversations);
  const groups = useMemo(() => groupByWorkspace(workspaces, conversations), [workspaces, conversations]);
  const refresh = useWorkspace((s) => s.refreshConversations);
  const loaded = useWorkspace((s) => s.loaded);
  const current = useChat((s) => s.conversationId);
  const newConversation = useChat((s) => s.newConversation);
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();

  const onNew = async () => {
    const id = await newConversation();
    if (id) {
      navigate(`/c/${id}`);
      void refresh();
    }
  };

  return (
    <aside className="conv-list flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-secondary p-3">
      {/* 品牌 + 用户区 */}
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-sm font-semibold tracking-tight text-foreground">agentany</span>
      </div>
      <div className="mb-3 flex items-center justify-between gap-2 px-1">
        <span className="truncate text-xs text-muted-foreground">
          {status === "authenticated" ? (user?.displayName ?? user?.username ?? "已登录") : "开发模式（匿名）"}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {/* 管理入口（f4 实装内容；仅 admin 可见——dev 匿名身份后端即 admin） */}
          {(status === "anonymous" || user?.role === "admin") && (
            <button
              onClick={() => navigate("/admin")}
              className="rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              管理
            </button>
          )}
          {status === "authenticated" && (
            <button
              onClick={() => void logout()}
              className="rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              登出
            </button>
          )}
        </div>
      </div>

      <button className="new mb-2 rounded-md border border-dashed border-muted-foreground bg-card px-3 py-2 text-sm text-card-foreground hover:opacity-80" onClick={() => void onNew()}>
        + 新会话
      </button>

      {/* 会话列表：按 ws 分组 */}
      {!loaded && <div className="px-1 py-4 text-center text-xs text-muted-foreground">加载中…</div>}
      {loaded && groups.length === 0 && <div className="px-1 py-4 text-center text-xs text-muted-foreground">暂无会话</div>}
      {groups.map((g) => (
        <div key={g.workspace.id} className="flex flex-col gap-0.5">
          <div className="mt-2 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g.workspace.name}</div>
          {g.items.map((c) => (
            <button
              key={c.id}
              className={`item truncate rounded-md px-3 py-1.5 text-left text-sm ${c.id === current ? "active" : "text-foreground hover:bg-accent"}`}
              onClick={() => navigate(`/c/${c.id}`)}
              title={c.title ?? c.id}
            >
              {c.title || `会话 ${c.id.slice(-6)}`}
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}
