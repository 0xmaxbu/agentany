// 左栏（f2-3 三区之一）：品牌 + 用户区 + 新会话 + 会话列表按 ws 分组。
// 契约类（e2e）：aside.conv-list / button.new / button.item——顺序 = updatedAt 倒序（组内）。
// 切换/新建直接 navigate（URL 唯一真相——ChatPage params effect 单向驱动 store）。
// #21/ADR-0020：item 悬浮菜单（member 归档；admin +删除确认）；底部「归档」折叠区（恢复/admin 删）。
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, ArrowUUpLeftIcon, TrashIcon } from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspace";
import { useChat } from "../store/chat";
import { useAuth, ROLE } from "../store/auth";
import { groupByWorkspace } from "../lib/group";

/**
 * 当前会话消失（归档/删除）后的补位跳转（#21 修复）：
 * 还有剩余活跃会话 → 跳第一条（列表顶）；没有了 → 跳 /（index effect 才新建）。
 * 直接 navigate("/") 会触发 index 自动新建——列表 -1+1 长度不变，看起来像归档没生效。
 */
function useFallbackNav() {
  const navigate = useNavigate();
  return (removedId: string) => {
    const rest = useWorkspace.getState().conversations.filter((c) => c.id !== removedId);
    navigate(rest.length > 0 ? `/c/${rest[0].id}` : "/");
  };
}

/** item 悬浮操作（#21）。confirm 态内联（不引 Radix——f4 再统一）。 */
function ConvItemActions({ convId, isAdmin, onRemoved }: { convId: string; isAdmin: boolean; onRemoved: () => void }) {
  const archive = useWorkspace((s) => s.archive);
  const remove = useWorkspace((s) => s.remove);
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <button className="text-[11px] text-destructive hover:underline" onClick={() => void remove(convId).then(onRemoved)}>
          确认删除
        </button>
        <button className="text-[11px] text-muted-foreground hover:underline" onClick={() => setConfirming(false)}>
          取消
        </button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      <button
        title="归档"
        className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => void archive(convId).then(onRemoved)}
      >
        <ArchiveIcon size={13} />
      </button>
      {isAdmin && (
        <button
          title="删除（不可恢复）"
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
          onClick={() => setConfirming(true)}
        >
          <TrashIcon size={13} />
        </button>
      )}
    </span>
  );
}

/** 归档折叠区（#21）：入口在侧栏底部；展开按需拉归档列表。 */
function ArchiveSection() {
  const [open, setOpen] = useState(false);
  const archived = useWorkspace((s) => s.archivedConversations);
  const refreshArchived = useWorkspace((s) => s.refreshArchived);
  const restore = useWorkspace((s) => s.restore);
  const remove = useWorkspace((s) => s.remove);
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const isAdmin = status === "anonymous" || user?.role === ROLE.admin; // dev 匿名身份后端即 admin
  const navigate = useNavigate();
  const current = useChat((s) => s.conversationId);
  const fallbackNav = useFallbackNav();

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void refreshArchived(); // 展开按需拉（归档列表低频，不进首载）
  };

  return (
    <div className="mt-auto border-t border-border pt-2">
      <button className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground" onClick={toggle}>
        <ArchiveIcon size={12} />
        归档
      </button>
      {open && (
        <div className="flex flex-col gap-0.5">
          {archived.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">暂无归档会话</div>}
          {archived.map((c) => (
            <div key={c.id} className={`archived-item flex items-center justify-between gap-1 rounded-md px-2 py-1 hover:bg-accent ${c.id === current ? "bg-accent" : ""}`}>
              <button
                className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground"
                onClick={() => navigate(`/c/${c.id}`)}
                title={c.title ?? c.id}
              >
                {c.title || `会话 ${c.id.slice(-6)}`}
              </button>
              <span className="flex shrink-0 items-center gap-0.5">
                <button title="恢复" className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => void restore(c.id)}>
                  <ArrowUUpLeftIcon size={13} />
                </button>
                {isAdmin && (
                  <button title="删除（不可恢复）" className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive" onClick={() => void remove(c.id).then(() => { if (c.id === current) fallbackNav(c.id); })}>
                    <TrashIcon size={13} />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const isAdmin = status === "anonymous" || user?.role === ROLE.admin;
  const navigate = useNavigate();
  const fallbackNav = useFallbackNav();

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
          {isAdmin && (
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
            <div key={c.id} className="group/item relative flex items-center">
              <button
                className={`item min-w-0 flex-1 truncate rounded-md px-3 py-1.5 text-left text-sm ${c.id === current ? "active" : "text-foreground hover:bg-accent"}`}
                onClick={() => navigate(`/c/${c.id}`)}
                title={c.title ?? c.id}
              >
                {c.title || `会话 ${c.id.slice(-6)}`}
              </button>
              <span className="absolute right-1 hidden group-hover/item:flex">
                <ConvItemActions convId={c.id} isAdmin={isAdmin} onRemoved={() => { if (c.id === current) fallbackNav(c.id); }} />
              </span>
            </div>
          ))}
        </div>
      ))}

      <ArchiveSection />
    </aside>
  );
}
