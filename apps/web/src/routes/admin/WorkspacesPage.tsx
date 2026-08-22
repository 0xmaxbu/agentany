// Workspace 管理（f4）：表格 + 搜索 + 新建/编辑弹窗（页面默认仅表格）。渲染在 shell 中区。
// 编辑弹窗：name/allUsers/成员名单（allUsers 开时名单灰掉——权限=allUsers ∪ 名单）。
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../api";
import { useAuth, ROLE } from "../../store/auth";
import { COMPANY_WORKSPACE_ID } from "../../store/workspace"; // 域常量唯一源（本地不重定义）
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog } from "../../components/ui/dialog";
import { ThemeToggle } from "../../components/ui/theme-toggle";
import { NoAccess } from "../../components/ui/no-access";
import type { AdminUserRow } from "./UsersPage";

const IW = 1.5; // 图标线宽全局统一
const jsonHeaders = { "Content-Type": "application/json" };

export interface AdminWorkspaceRow {
  id: string; slug: string; name: string; allUsers: boolean; createdAt: string; updatedAt: string;
  archivedAt?: string | null; // #手风琴：归档 switch 状态（公司 ws 恒 null）
}
interface WsMember {
  userId: string; username?: string; displayName?: string | null;
}

// 管理页要看全部（活跃 + 归档——恢复入口）；合并两个列表按 updatedAt 倒序。
const listWorkspaces = async (): Promise<AdminWorkspaceRow[]> => {
  const [live, archived] = await Promise.all([
    apiFetch("/workspaces").then((r) => (r.ok ? (r.json() as Promise<AdminWorkspaceRow[]>) : [])),
    apiFetch("/workspaces?archived=1").then((r) => (r.ok ? (r.json() as Promise<AdminWorkspaceRow[]>) : [])),
  ]);
  return [...live, ...archived].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};
const archiveWs = async (id: string) => {
  const r = await apiFetch(`/workspaces/${id}/archive`, { method: "PATCH" });
  if (!r.ok) throw new Error(`archiveWs: ${r.status}`);
};
const restoreWs = async (id: string) => {
  const r = await apiFetch(`/workspaces/${id}/restore`, { method: "PATCH" });
  if (!r.ok) throw new Error(`restoreWs: ${r.status}`);
};
const getWorkspace = async (id: string): Promise<AdminWorkspaceRow & { members: WsMember[] }> => {
  const r = await apiFetch(`/workspaces/${id}`);
  if (!r.ok) throw new Error(`getWorkspace: ${r.status}`);
  return r.json();
};
const listUsers = async (): Promise<AdminUserRow[]> => {
  const r = await apiFetch("/users");
  if (!r.ok) throw new Error(`listUsers: ${r.status}`);
  return r.json();
};
const createWorkspace = async (p: { name: string; allUsers: boolean; memberIds: string[] }) => {
  const r = await apiFetch("/workspaces", { method: "POST", headers: jsonHeaders, body: JSON.stringify(p) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `createWorkspace: ${r.status}`);
};
const updateWorkspace = async (id: string, patch: { name?: string; allUsers?: boolean }) => {
  const r = await apiFetch(`/workspaces/${id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(`updateWorkspace: ${r.status}`);
};
const addMember = async (id: string, userId: string) => {
  const r = await apiFetch(`/workspaces/${id}/members`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ userId }) });
  if (!r.ok) throw new Error(`addMember: ${r.status}`);
};
const removeMember = async (id: string, userId: string) => {
  const r = await apiFetch(`/workspaces/${id}/members/${userId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`removeMember: ${r.status}`);
};

export function AdminWorkspacesPage() {
  const [wss, setWss] = useState<AdminWorkspaceRow[] | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminWorkspaceRow | null>(null);
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const isAdmin = status === "anonymous" || user?.role === ROLE.admin;

  const reload = () => {
    void listWorkspaces().then(setWss).catch((e) => setErr(String(e.message ?? e)));
    void listUsers().then(setUsers).catch(() => {});
  };
  useEffect(reload, []);

  /** 归档 switch 乐观翻转：本地先行（受控 checked 即时响应），API 成功 reload 校正、失败回滚。 */
  const toggleArchive = (w: AdminWorkspaceRow, toArchived: boolean) => {
    setWss((prev) => (prev ?? []).map((x) => (x.id === w.id ? { ...x, archivedAt: toArchived ? new Date().toISOString() : null } : x)));
    void (toArchived ? archiveWs(w.id) : restoreWs(w.id))
      .then(reload)
      .catch(() => {
        setWss((prev) => (prev ?? []).map((x) => (x.id === w.id ? { ...x, archivedAt: w.archivedAt ?? null } : x)));
      });
  };

  // 搜索：name/slug 不分大小写包含
  const filtered = useMemo(() => {
    if (!wss) return null;
    const q = query.trim().toLowerCase();
    if (!q) return wss;
    return wss.filter((w) => w.name.toLowerCase().includes(q) || w.slug.toLowerCase().includes(q));
  }, [wss, query]);

  if (!isAdmin) return <NoAccess />;

  return (
    <div className="main flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <h1 className="text-base font-semibold">Workspace 管理</h1>
        <ThemeToggle />
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 pb-3">
          <div className="relative flex-1">
            <MagnifyingGlassIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-full py-1.5 pl-7 pr-2"
              placeholder="搜索名称 / slug…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="ws-search"
            />
          </div>
          <Button size="sm" onClick={() => setCreating(true)} data-testid="open-create-ws">
            新建 Workspace
          </Button>
        </div>

        {err && <p className="mx-auto mb-4 max-w-3xl text-sm text-destructive">{err}</p>}
        {filtered === null && <p className="text-sm text-muted-foreground">加载中…</p>}
        {filtered !== null && (
          <div className="mx-auto max-w-3xl overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm" data-testid="ws-table">
              <thead>
                <tr className="border-b border-border bg-secondary/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">名称</th>
                  <th className="px-3 py-2 font-medium">Slug</th>
                  <th className="px-3 py-2 font-medium">可见性</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((w) => {
                  const archived = w.archivedAt != null;
                  const isCompany = w.id === COMPANY_WORKSPACE_ID;
                  return (
                    <tr key={w.id} className={`border-b border-border/50 last:border-0 hover:bg-accent/40 ${archived ? "opacity-50" : ""}`}>
                      <td className="px-3 py-2">
                        {w.name}
                        {archived && <span className="ml-1.5 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">已归档</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{w.slug}</td>
                      <td className="px-3 py-2 text-xs">
                        {w.allUsers ? (
                          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px]">全员可见</span>
                        ) : (
                          <span className="text-muted-foreground">名单制</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className="flex items-center justify-end gap-3">
                          {/* 归档 switch（#手风琴）：可逆无确认；公司 ws 不显示（系统锚不可归档） */}
                          {!isCompany && (
                            <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground" title={archived ? "恢复 workspace" : "归档（侧栏隐藏，会话可看可发）"}>
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5 accent-primary"
                                checked={!archived}
                                onChange={(e) => toggleArchive(w, !e.target.checked)}
                                data-testid={`ws-archive-switch-${w.slug}`}
                              />
                              {archived ? "已归档" : "可见"}
                            </label>
                          )}
                          <Button variant="outline" size="xs" onClick={() => setEditing(w)}>编辑</Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground">{query ? "无匹配 Workspace" : "暂无 Workspace"}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateWsDialog open={creating} onClose={() => setCreating(false)} users={users} onCreated={reload} />
      <EditWsDialog ws={editing} onClose={() => setEditing(null)} users={users} onChanged={reload} />
    </div>
  );
}

const PLATFORM_TITLES: Record<string, string> = { feishu: "飞书", telegram: "Telegram" };

/** 名单编辑子组件（新建/编辑弹窗共用）：chips + 下拉添加。allUsers 开时灰掉。 */
function MemberList({ users, members, onAdd, onRemove, disabled }: {
  users: AdminUserRow[]; members: WsMember[]; onAdd: (userId: string) => void; onRemove: (userId: string) => void; disabled: boolean;
}) {
  const memberIds = new Set(members.map((m) => m.userId));
  const candidates = users.filter((u) => u.status === "active" && !memberIds.has(u.id));
  return (
    <div className={`flex flex-col gap-1 ${disabled ? "pointer-events-none opacity-40" : ""}`}>
      <span className="text-xs text-muted-foreground">成员名单（权限 = 全员开关 ∪ 名单）</span>
      <div className="flex flex-wrap items-center gap-1">
        {members.map((m) => (
          <span key={m.userId} className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">
            {m.displayName ?? m.username ?? m.userId}
            <button
              className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onRemove(m.userId)}
              aria-label={`移除成员 ${m.displayName ?? m.username ?? m.userId}`}
            >
              <XIcon size={11} strokeWidth={IW} />
            </button>
          </span>
        ))}
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
          value=""
          onChange={(e) => { const id = e.target.value; if (id) onAdd(id); }}
        >
          <option value="">+ 添加成员…</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>{u.displayName ?? u.username}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function CreateWsDialog({ open, onClose, users, onCreated }: { open: boolean; onClose: () => void; users: AdminUserRow[]; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [allUsers, setAllUsers] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => { setName(""); setAllUsers(false); setMemberIds([]); setErr(null); onClose(); };

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try {
      await createWorkspace({ name: name.trim(), allUsers, memberIds: allUsers ? [] : memberIds });
      onCreated();
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const members = memberIds.map((id) => {
    const u = users.find((x) => x.id === id);
    return { userId: id, username: u?.username, displayName: u?.displayName };
  });

  return (
    <Dialog open={open} onClose={close} title="新建 Workspace">
      <div className="flex flex-col gap-2">
        <Input className="py-1.5" placeholder="名称（如：acme 品牌）" value={name} onChange={(e) => setName(e.target.value)} data-testid="new-ws-name" />
        <p className="text-xs text-muted-foreground">slug 自动生成（检索用标识，无需填写）。</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allUsers} onChange={(e) => setAllUsers(e.target.checked)} data-testid="new-ws-allusers" />
          全员可见（开时忽略成员名单）
        </label>
        <MemberList
          users={users}
          members={members}
          disabled={allUsers}
          onAdd={(id) => setMemberIds((prev) => [...prev, id])}
          onRemove={(id) => setMemberIds((prev) => prev.filter((m) => m !== id))}
        />
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={close}>取消</Button>
          <Button size="sm" disabled={busy || !name.trim()} onClick={() => void submit()} data-testid="create-ws">创建</Button>
        </div>
      </div>
    </Dialog>
  );
}

function EditWsDialog({ ws, onClose, users, onChanged }: { ws: AdminWorkspaceRow | null; onClose: () => void; users: AdminUserRow[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [allUsers, setAllUsers] = useState(false);
  const [members, setMembers] = useState<WsMember[] | null>(null); // null = 加载中
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 开弹窗时拉详情（members 列表）
  useEffect(() => {
    if (!ws) return;
    setName(ws.name);
    setAllUsers(ws.allUsers);
    setMembers(null);
    setErr(null);
    void getWorkspace(ws.id).then((d) => setMembers(d.members)).catch((e) => setErr(String(e.message ?? e)));
  }, [ws]);

  const save = async () => {
    if (!ws) return;
    setBusy(true); setErr(null);
    try {
      await updateWorkspace(ws.id, { name: name.trim(), allUsers });
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={ws !== null} onClose={onClose} title={ws ? `编辑：${ws.name}` : ""}>
      <div className="flex flex-col gap-2">
        <Input className="py-1.5" value={name} onChange={(e) => setName(e.target.value)} data-testid="edit-ws-name" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allUsers} onChange={(e) => setAllUsers(e.target.checked)} />
          全员可见
        </label>
        {members === null ? (
          <p className="text-xs text-muted-foreground">加载名单…</p>
        ) : (
          <MemberList
            users={users}
            members={members}
            disabled={allUsers}
            onAdd={(id) => {
              const u = users.find((x) => x.id === id);
              setMembers((prev) => [...(prev ?? []), { userId: id, username: u?.username, displayName: u?.displayName }]);
              if (ws) void addMember(ws.id, id).catch((e) => setErr(String(e.message ?? e))); // 名单即时落库（增删是原子小操作）
            }}
            onRemove={(id) => {
              setMembers((prev) => (prev ?? []).filter((m) => m.userId !== id));
              if (ws) void removeMember(ws.id, id).catch((e) => setErr(String(e.message ?? e)));
            }}
          />
        )}
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={busy} onClick={() => void save()} data-testid="edit-ws-save">保存</Button>
        </div>
      </div>
    </Dialog>
  );
}
