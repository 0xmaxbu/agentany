// 左栏（f2-3 三区之一）：品牌 + 用户区 + 新会话 + 会话列表按 ws 分组。
// 契约类（e2e）：aside.conv-list / button.new / button.item——顺序 = updatedAt 倒序（组内）。
// 切换/新建直接 navigate（URL 唯一真相——ChatPage params effect 单向驱动 store）。
// #21/ADR-0020：item 悬浮菜单（member 归档；admin +删除确认）；底部「归档」折叠区（恢复/admin 删）。
// #62：UserFooter 弹菜单加「绑定飞书」（管理和登出之间）——点击弹窗（自助发码 + 4 位码 + 倒计时；绑定成功→2s 自动关）+ 已绑定 tag。
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ArchiveIcon, ArrowUUpLeftIcon, CaretDownIcon, CaretRightIcon, GearSixIcon, MagnifyingGlassIcon, PlusIcon, SignOutIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { COMPANY_WORKSPACE_ID, PAGE_SIZE, UNTITLED, useWorkspace } from "../store/workspace";
import { useChat } from "../store/chat";
import { useAuth, ROLE } from "../store/auth";
import { listConversations, issueBindCode, listImBindings, type ConversationRow, type Workspace } from "../api";
import { Dialog } from "./ui/dialog";

const IW = 1.5; // 图标线宽全局统一（design 纪律——本文件此前漏配 12 处，chat-optimize 补齐）

/** 微图标钮通用态：hover/焦点环/过渡 + p-1 扩命中区（14 图标 → 24px）。 */
const ICON_BTN =
  "rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 管理菜单（f4）：「所有 admin 管理项目」可扩展列表——M4 定时任务、M5 人审后续挂这。 */
const ADMIN_MENU = [
  { path: "/admin/users", label: "用户" },
  { path: "/admin/workspaces", label: "Workspace" },
  { path: "/admin/tasks", label: "定时任务" },
] as const;

/**
 * 侧栏底部用户行（Kimi 式）：头像圈 + 昵称，hover/点击弹出向上菜单（管理/登出收入菜单）。
 * 顶部不再放用户操作——单行身份 + 弹菜单，主列表空间还给会话。
 */
function UserFooter({ isAdmin, onBindOpen }: { isAdmin: boolean; onBindOpen: () => void }) {
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const name = status === "authenticated" ? (user?.displayName ?? user?.username ?? "已登录") : "开发模式（匿名）";
  const initial = (user?.displayName ?? user?.username ?? "A").slice(0, 1).toUpperCase();

  return (
    <div
      className="relative mt-auto shrink-0 border-t border-border pt-2"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="user-footer"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
          {initial}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{name}</span>
      </button>
      {open && (
        <div className="reveal absolute bottom-full left-0 right-0 mb-1 flex flex-col gap-0.5 rounded-md border border-border bg-card p-1 shadow-md">
          {isAdmin && (
            <button
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setOpen(false);
                navigate("/admin/users");
              }}
            >
              <GearSixIcon size={14} strokeWidth={IW} />
              管理
            </button>
          )}
          {isAdmin && <BindFeishuMenuItem onOpen={() => { setOpen(false); onBindOpen(); }} />}
          {status === "authenticated" && (
            <button
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setOpen(false);
                void logout();
              }}
            >
              <SignOutIcon size={14} strokeWidth={IW} />
              登出
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 当前会话消失（归档/删除）后的补位跳转（#21 修复）：
 * 还有剩余活跃会话 → 跳第一条（列表顶）；没有了 → 跳 /（index effect 才新建）。
 * 直接 navigate("/") 会触发 index 自动新建——列表 -1+1 长度不变，看起来像归档没生效。
 */
function useFallbackNav() {
  const navigate = useNavigate();
  return (removedId: string) => {
    // #手风琴：跨已加载组取第一条（公司组优先——组序已排好）
    const s = useWorkspace.getState();
    const all = Object.values(s.groups).flatMap((g) => g.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const rest = all.filter((c) => c.id !== removedId);
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
        <button className="rounded px-0.5 text-[11px] text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void remove(convId).then(onRemoved)}>
          确认删除
        </button>
        <button className="rounded px-0.5 text-[11px] text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setConfirming(false)}>
          取消
        </button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      <button
        title="归档"
        className={ICON_BTN}
        onClick={() => void archive(convId).then(onRemoved)}
      >
        <ArchiveIcon size={14} strokeWidth={IW} />
      </button>
      {isAdmin && (
        <button
          title="删除（不可恢复）"
          className={`${ICON_BTN} hover:text-destructive`}
          onClick={() => setConfirming(true)}
        >
          <TrashIcon size={14} strokeWidth={IW} />
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
    <div className="border-t border-border pt-2">
      <button className="flex w-full items-center gap-1 rounded px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={toggle}>
        <ArchiveIcon size={12} strokeWidth={IW} />
        归档
      </button>
      {open && (
        <div className="reveal flex flex-col gap-0.5">
          {archived.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">暂无归档会话</div>}
          {archived.map((c) => (
            <div key={c.id} className={`archived-item flex items-center justify-between gap-1 rounded-md px-2 py-1 hover:bg-accent ${c.id === current ? "bg-accent" : ""}`}>
              <button
                className="min-w-0 flex-1 truncate rounded text-left text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => navigate(`/c/${c.id}`)}
                title={c.title ?? c.id}
              >
                {c.title || UNTITLED}
              </button>
              <span className="flex shrink-0 items-center gap-0.5">
                <button title="恢复" className={ICON_BTN} onClick={() => void restore(c.id)}>
                  <ArrowUUpLeftIcon size={14} strokeWidth={IW} />
                </button>
                {isAdmin && (
                  <button title="删除（不可恢复）" className={`${ICON_BTN} hover:text-destructive`} onClick={() => void remove(c.id).then(() => { if (c.id === current) fallbackNav(c.id); })}>
                    <TrashIcon size={14} strokeWidth={IW} />
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
  const loaded = useWorkspace((s) => s.loaded);
  const current = useChat((s) => s.conversationId);
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const isAdmin = status === "anonymous" || user?.role === ROLE.admin;
  const navigate = useNavigate();
  const fallbackNav = useFallbackNav();
  const pathname = useLocation().pathname; // f4：Sidebar 双态（组件不卸载，只换中间内容）
  const adminMode = pathname.startsWith("/admin");
  const [bindOpen, setBindOpen] = useState(false); // 绑定飞书弹窗（#62）

  // admin→chat 切回时刷新 ws 列表与已展开组（管理页建的 ws/归档/会话变动经此同步；
  // 首载由 ShellLayout load() 负责，这里只管「回来」）。prevRef 防 StrictMode 双跑。
  const prevAdmin = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevAdmin.current === true && !adminMode) void useWorkspace.getState().load();
    prevAdmin.current = adminMode;
  }, [adminMode]);

  return (
    <aside className="conv-list flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-secondary p-3">
      {/* 品牌行（用户操作收入底部 UserFooter 弹菜单——Kimi 式） */}
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-sm font-semibold tracking-tight text-foreground">agentany</span>
      </div>

      {/* admin 态（f4）：中间内容区整体换管理菜单（品牌/用户区保留；组件不卸载——切页只刷中区） */}
      {adminMode ? (
        <div className="flex flex-col gap-0.5">
          <button
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => navigate("/")}
          >
            <ArrowUUpLeftIcon size={14} strokeWidth={IW} />
            返回对话
          </button>
          {ADMIN_MENU.map((m) => (
            <button
              key={m.path}
              className={`item rounded-md px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${pathname === m.path ? "active" : "text-foreground hover:bg-accent"}`}
              onClick={() => navigate(m.path)}
            >
              {m.label}
            </button>
          ))}
        </div>
      ) : (
        <ConvAccordion isAdmin={isAdmin} current={current} loaded={loaded} fallbackNav={fallbackNav} />
      )}

      {/* 底部用户行（Kimi 式）：头像 + 昵称，hover 弹菜单（管理/绑定飞书/登出） */}
      <UserFooter isAdmin={isAdmin} onBindOpen={() => setBindOpen(true)} />

      {/* 绑定飞书弹窗（#62）：自助发码 → 飞书 #bind → 轮询检测成功 → 2s 自动关 */}
      <BindFeishuDialog open={bindOpen} onClose={() => setBindOpen(false)} />
    </aside>
  );
}

/** 菜单项：绑定飞书（#62）——已绑定显 tag；点击开弹窗（无导航路由）。用户弹菜单内（管理和登出之间）。 */
function BindFeishuMenuItem({ onOpen }: { onOpen: () => void }) {
  const bound = useFeishuBound();
  return (
    <button
      className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
      onClick={onOpen}
      data-testid="bind-feishu"
    >
      绑定飞书
      {bound && <span className="rounded-sm bg-success/15 px-1.5 py-0.5 text-[10px] text-success" data-testid="bind-feishu-tag">已绑定</span>}
    </button>
  );
}

/** 当前用户是否已绑定飞书（弹窗打开/成功/poll 用；查一次缓存到组件卸载）。 */
function useFeishuBound(): boolean {
  const user = useAuth((s) => s.user);
  const [bound, setBound] = useState(false);
  // 首次加载 + user 到位后查（匿名 dev 也查——imStore 空则 false）
  useEffect(() => {
    let alive = true;
    void listImBindings()
      .then((bs) => { if (alive && user) setBound(bs.some((b) => b.userId === user.id && b.platform === "feishu")); })
      .catch(() => { /* im 未接线（503）→ 未绑定 */ });
    return () => { alive = false; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return bound;
}

/**
 * 绑定飞书弹窗（#62）：打开即自助发码（4 位数字 + 10min）→ 飞书私聊 `#bind <码>` →
 * 轮询 bindings 检测本用户已绑 → 切换「绑定成功」态 → 2s 自动关闭。
 * 倒计时到期 → 码失效，自动重发新码（服务端旧码 TTL 兜底，无竞态）。
 */
function BindFeishuDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const user = useAuth((s) => s.user);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now()); // 受控时钟：倒计时推进也驱动重发判定
  const [bound, setBound] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const codeRef = useRef<string | null>(null);   // 当前展示码（ref 镜像：boot 闭包需跨轮读，重发判定用）
  const expiresRef = useRef<string | null>(null);
  // 未绑 → 复用未过期码（不复发）；无码/已过期才发新码；已绑 → 切成功态
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBound(false); setErr(null);
    const boot = () => {
      if (!alive) return;
      void listImBindings().then((bs) => {
        if (user && bs.some((b) => b.userId === user.id && b.platform === "feishu")) { setBound(true); return; }
        const exp = expiresRef.current ? new Date(expiresRef.current).getTime() : 0;
        if (codeRef.current && exp > Date.now()) { setNow(Date.now()); return; } // 码还有效 → 不动（避免 3s 一换）
        void issueBindCode().then((d) => {
          if (!alive) return;
          codeRef.current = d.code; expiresRef.current = d.expiresAt;
          setCode(d.code); setExpiresAt(d.expiresAt); setNow(Date.now());
        });
      }).catch(() => setErr("飞书未接线（服务端缺凭证）"));
    };
    boot();
    const poll = setInterval(boot, 3000); // 3s 轮询：检测绑定成功 + TTL 到期重发
    return () => { alive = false; clearInterval(poll); };
  }, [open, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 绑定成功 → 2s 自动关闭
  useEffect(() => {
    if (!bound) return;
    const t = setTimeout(onClose, 2000);
    return () => clearTimeout(t);
  }, [bound, onClose]);

  // 倒计时每秒推进（仅网关态；过期由 poll 3s 重发）
  useEffect(() => {
    if (!open || bound || !expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, bound, expiresAt]);

  return (
    <Dialog open={open} onClose={onClose} title="绑定飞书">
      {bound ? (
        <p className="text-sm text-success" data-testid="bind-success">已绑定飞书，卡片将推送到您的飞书。</p>
      ) : code && expiresAt ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">在飞书私聊机器人发送：</p>
          <p className="rounded-md bg-muted px-2 py-1.5 font-mono text-xs" data-testid="bind-command">#bind {code}</p>
          <p className="text-[11px] text-muted-foreground" data-testid="bind-countdown">
            码有效期：{formatCountdown(expiresAt, now)}
          </p>
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{err ?? "加载中…"}</p>
      )}
    </Dialog>
  );
}

/** 倒计时：X 分 X 秒；过期 → 「已过期，正在重新获取…」（时钟仅每秒由 countdown 状态驱动）。 */
function formatCountdown(expiresAt: string, now: number): string {
  const remain = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  if (remain <= 0) return "已过期，正在自动重发…";
  const m = Math.floor(remain / 60);
  const s = remain % 60;
  return `${m}分${String(s).padStart(2, "0")}秒`;
}

/**
 * 会话手风琴（#手风琴 grill 定稿）：
 * - 组 = 可访问的 ws；公司置顶 + 其余按 lastActiveAt 倒序（store 已排好）
 * - 默认只展开公司；其他组点击展开——首次展开懒加载 10 条；各组「加载更多」
 * - 组头：ws 名 + 展开箭头 + 「+」（在该 ws 建会话）
 * - 搜索：query 非空时用全量 searchAll 过滤（跨组），清空回分页态
 */
function ConvAccordion({ isAdmin, current, loaded, fallbackNav }: {
  isAdmin: boolean; current: string | null; loaded: boolean; fallbackNav: (removedId: string) => void;
}) {
  const workspaces = useWorkspace((s) => s.workspaces);
  const groups = useWorkspace((s) => s.groups);
  const query = useWorkspace((s) => s.query);
  const searchAll = useWorkspace((s) => s.searchAll);
  const setQuery = useWorkspace((s) => s.setQuery);
  const expandGroup = useWorkspace((s) => s.expandGroup);
  const newConversation = useChat((s) => s.newConversation);
  const navigate = useNavigate();
  // 展开态（组件内 state）：默认只展开公司（ grill Q2 决定）
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([COMPANY_WORKSPACE_ID]));
  const [browseFor, setBrowseFor] = useState<Workspace | null>(null); // 「全部会话」弹窗目标 ws

  const toggle = (wsId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else {
        next.add(wsId);
        void expandGroup(wsId); // 首次展开懒加载（store 幂等）
      }
      return next;
    });
  };

  const newInWs = async (wsId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // 不触发组头 toggle
    const id = await newConversation(wsId);
    if (id) {
      navigate(`/c/${id}`);
      void useWorkspace.getState().refreshConversations();
    }
  };

  // 搜索态：全量过滤（跨组扁平展示命中项）。匹配显示名（title ?? 尾码——与 UI 渲染一致）或完整 id。
  const searching = query !== "";
  const searchHits = useMemo(() => {
    if (!searching || !searchAll) return null;
    const q = query.toLowerCase();
    return searchAll.filter((c) => (c.title ?? UNTITLED).toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  }, [searching, searchAll, query]);

  return (
    <>
      {/* 搜索框（#手风琴）：空=分页态；非空全量过滤 */}
      <div className="relative mb-2">
        <MagnifyingGlassIcon size={14} strokeWidth={IW} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          className="w-full rounded-md border border-input bg-background py-1.5 pl-7 pr-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
          placeholder="搜索会话…"
          value={query}
          onChange={(e) => void setQuery(e.target.value)}
          data-testid="conv-search"
        />
      </div>

      {!loaded && <div className="px-1 py-4 text-center text-xs text-muted-foreground">加载中…</div>}

      {searching ? (
        <>
          {searchHits === null && <div className="px-1 py-4 text-center text-xs text-muted-foreground">搜索中…</div>}
          {searchHits !== null && searchHits.length === 0 && <div className="px-1 py-4 text-center text-xs text-muted-foreground">无匹配会话</div>}
          {searchHits?.map((c) => (
            <ConvItem key={c.id} c={c} current={current} isAdmin={isAdmin} fallbackNav={fallbackNav} />
          ))}
        </>
      ) : (
        <>
          {loaded && workspaces.length === 0 && <div className="px-1 py-4 text-center text-xs text-muted-foreground">暂无 workspace</div>}
          {workspaces.map((w) => {
            const g = groups[w.id];
            const open = expanded.has(w.id);
            return (
              <div key={w.id} className="flex flex-col gap-0.5" data-testid={`ws-group-${w.slug}`}>
                {/* 组头：箭头 + 名 + 「+」建会话（hover 或键盘聚焦行内均可见 +） */}
                <div className="group/head mt-1 flex items-center gap-1 px-1 py-1">
                  <button className="flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => toggle(w.id)} data-testid={`ws-toggle-${w.slug}`}>
                    {open ? <CaretDownIcon size={12} strokeWidth={IW} className="shrink-0 text-muted-foreground" /> : <CaretRightIcon size={12} strokeWidth={IW} className="shrink-0 text-muted-foreground" />}
                    <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground group-hover/head:text-foreground">{w.name}</span>
                  </button>
                  <button
                    className="hidden rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/head:block group-focus-within/head:block"
                    title={`在 ${w.name} 新建会话`}
                    onClick={(e) => void newInWs(w.id, e)}
                    data-testid={`ws-new-${w.slug}`}
                  >
                    <PlusIcon size={12} strokeWidth={IW} />
                  </button>
                </div>
                {open && (
                  <>
                    {(g?.items ?? []).map((c) => (
                      <ConvItem key={c.id} c={c} current={current} isAdmin={isAdmin} fallbackNav={fallbackNav} />
                    ))}
                    {/* #手风琴-2：>5 条时「全部会话」弹窗入口（组内固定 5 条直显） */}
                    {g && g.items.length >= PAGE_SIZE && (
                      <button className="px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => setBrowseFor(w)} data-testid={`ws-all-${w.slug}`}>
                        全部会话
                      </button>
                    )}
                    {g && g.items.length < PAGE_SIZE && g.items.length === 0 && <div className="px-3 py-1 text-xs text-muted-foreground">暂无会话</div>}
                    {!g && <div className="px-3 py-1 text-xs text-muted-foreground">加载中…</div>}
                  </>
                )}
              </div>
            );
          })}
        </>
      )}

      <ArchiveSection />

      {/* 全部会话弹窗（#手风琴-2）：该 ws 全部会话 updatedAt 倒序，滚动到底自动加载 */}
      <BrowseDialog ws={browseFor} current={current} isAdmin={isAdmin} fallbackNav={fallbackNav} onClose={() => setBrowseFor(null)} />
    </>
  );
}

/** 单条会话项（契约类 .item 保留）。 */
/** 相对活跃时间（#手风琴-2 弹窗用）：<1 分「刚刚」、<1 时 N 分、<24 时 N 时、更早 MM-DD。 */
const relativeTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function ConvItem({ c, current, isAdmin, fallbackNav, showTime = false }: { c: ConversationRow; current: string | null; isAdmin: boolean; fallbackNav: (removedId: string) => void; showTime?: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="group/item relative flex items-center">
      <button
        className={`item min-w-0 flex-1 truncate rounded-md px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${c.id === current ? "active" : "text-foreground hover:bg-accent"}`}
        onClick={() => navigate(`/c/${c.id}`)}
        data-testid={`conv-item-${c.id}`} // #命名：显示名不再含 id——e2e 唯一定位锚
        title={c.title ?? c.id}
      >
        {c.title || UNTITLED}
      </button>
      {showTime && <span className="mr-2 shrink-0 self-center text-[10px] text-muted-foreground">{relativeTime(c.updatedAt)}</span>}
      <span className="absolute right-1 hidden group-hover/item:flex">
        <ConvItemActions convId={c.id} isAdmin={isAdmin} onRemoved={() => { if (c.id === current) fallbackNav(c.id); }} />
      </span>
    </div>
  );
}

/**
 * 全部会话弹窗（#手风琴-2）：某 ws 的全部会话（updatedAt 倒序）。
 * 固定高度 + 内部 scroll；滚动到底自动加载下一页（懒加载）；复用 ui/Dialog 骨架。
 * 自管分页（不复用 store groups——弹窗是独立浏览面，关掉即弃）。
 */
function BrowseDialog({ ws, current, isAdmin, fallbackNav, onClose }: {
  ws: Workspace | null; current: string | null; isAdmin: boolean; fallbackNav: (removedId: string) => void; onClose: () => void;
}) {
  const PAGE = 10;
  const [items, setItems] = useState<ConversationRow[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const started = useRef(false); // 首次打开拉第一页（防 StrictMode 双跑）

  const fetchPage = async (offset: number) => {
    setLoading(true);
    const more = await listConversations(false, { workspaceId: ws!.id, limit: PAGE, offset }).catch(() => [] as ConversationRow[]);
    setItems((prev) => {
      const seen = new Set(prev.map((c) => c.id));
      return [...prev, ...more.filter((c) => !seen.has(c.id))];
    });
    setExhausted(more.length < PAGE);
    setLoading(false);
  };

  useEffect(() => {
    if (!ws || started.current) return;
    started.current = true;
    setItems([]);
    setExhausted(false);
    void fetchPage(0);
  }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps

  // 滚动到底自动加载
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (exhausted || loading) return;
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) void fetchPage(items.length);
  };

  // 未溢出即续拉：一页不满一屏（scroll 事件永不发生）——加载完检查，直到溢出或 exhausted。
  useEffect(() => {
    if (!ws || loading || exhausted) return;
    const el = scrollRef.current;
    if (el && el.scrollHeight <= el.clientHeight) void fetchPage(items.length);
  }, [items, loading, exhausted, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ws) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose} data-testid="browse-backdrop">
      <div
        className="flex h-[60vh] w-full max-w-sm flex-col rounded-lg border border-border bg-card shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${ws.name} 全部会话`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{ws.name} · 全部会话</h2>
          <button className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onClose} data-testid="browse-close">
            <XIcon size={14} strokeWidth={IW} />
          </button>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-2" onScroll={onScroll} data-testid="browse-scroll">
          {items.map((c) => (
            <div key={c.id} onClick={onClose}> {/* 点会话进 chat 并关弹窗 */}
              <ConvItem c={c} current={current} isAdmin={isAdmin} fallbackNav={fallbackNav} showTime />
            </div>
          ))}
          {items.length === 0 && !loading && <div className="px-2 py-6 text-center text-xs text-muted-foreground">暂无会话</div>}
          {loading && <div className="px-2 py-2 text-center text-xs text-muted-foreground">加载中…</div>}
          {!loading && exhausted && items.length > 0 && <div className="px-2 py-2 text-center text-xs text-muted-foreground">已全部加载</div>}
        </div>
      </div>
    </div>
  );
}
