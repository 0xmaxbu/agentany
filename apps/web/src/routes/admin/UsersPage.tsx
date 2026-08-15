// 用户管理（f4）：表格 + 搜索 + 新建/重置密码弹窗（页面默认仅表格）。渲染在 shell 中区。
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { apiFetch } from "../../api";
import { useAuth, ROLE } from "../../store/auth";
import { useTheme } from "../../lib/theme";
import { CheckIcon, MagnifyingGlassIcon, ProhibitIcon } from "@phosphor-icons/react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";

const jsonHeaders = { "Content-Type": "application/json" };

export interface AdminUserRow {
  id: string; username: string; displayName: string | null; role: "admin" | "member";
  status: "active" | "deactivated"; createdAt: string;
}

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  return apiFetch(path, init);
}

const listUsers = async (): Promise<AdminUserRow[]> => {
  const r = await adminFetch("/users");
  if (!r.ok) throw new Error(`listUsers: ${r.status}`);
  return r.json();
};
const createUser = async (p: { username: string; password: string; displayName?: string; role: string }) => {
  const r = await adminFetch("/users", { method: "POST", headers: jsonHeaders, body: JSON.stringify(p) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `createUser: ${r.status}`);
};
const deactivateUser = async (id: string) => {
  const r = await adminFetch(`/users/${id}/deactivate`, { method: "POST" });
  if (!r.ok) throw new Error(`deactivate: ${r.status}`);
};
const activateUser = async (id: string) => {
  const r = await adminFetch(`/users/${id}/activate`, { method: "POST" });
  if (!r.ok) throw new Error(`activate: ${r.status}`);
};
const resetPassword = async (id: string, newPassword: string) => {
  const r = await adminFetch(`/users/${id}/reset-password`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ newPassword }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `resetPassword: ${r.status}`);
};

export function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<AdminUserRow | null>(null);
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const isAdmin = status === "anonymous" || user?.role === ROLE.admin;

  const reload = () => void listUsers().then(setUsers).catch((e) => setErr(String(e.message ?? e)));
  useEffect(reload, []);

  // 搜索：username/displayName 不分大小写包含
  const filtered = useMemo(() => {
    if (!users) return null;
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.username.toLowerCase().includes(q) || (u.displayName ?? "").toLowerCase().includes(q));
  }, [users, query]);

  if (!isAdmin) return <NoAccess />;

  return (
    <div className="main flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <h1 className="text-base font-semibold">用户管理</h1>
        <ThemeToggle />
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        {/* 工具行：搜索 + 新建 */}
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 pb-3">
          <div className="relative flex-1">
            <MagnifyingGlassIcon size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              className="w-full rounded-md border border-input bg-background py-1.5 pl-7 pr-2 text-sm"
              placeholder="搜索用户名 / 显示名…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="user-search"
            />
          </div>
          <Button className="h-8 px-3 text-xs" onClick={() => setCreating(true)} data-testid="open-create-user">
            新建用户
          </Button>
        </div>

        {err && <p className="mx-auto mb-4 max-w-3xl text-sm text-destructive">{err}</p>}
        {filtered === null && <p className="text-sm text-muted-foreground">加载中…</p>}
        {filtered !== null && (
          <div className="mx-auto max-w-3xl overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm" data-testid="users-table">
              <thead>
                <tr className="border-b border-border bg-secondary/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">用户</th>
                  <th className="px-3 py-2 font-medium">用户名</th>
                  <th className="px-3 py-2 font-medium">角色</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <UserRow key={u.id} u={u} self={u.id === user?.id} onReset={() => setResetting(u)} onChanged={reload} />
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">{query ? "无匹配用户" : "暂无用户"}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateUserDialog open={creating} onClose={() => setCreating(false)} onCreated={reload} />
      <ResetPasswordDialog u={resetting} onClose={() => setResetting(null)} onDone={reload} />
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="rounded-md border border-border bg-card px-2 py-1 text-xs text-card-foreground hover:opacity-80"
      title="切换主题"
    >
      {theme === "dark" ? "浅色" : "深色"}
    </button>
  );
}

function NoAccess() {
  const navigate = useNavigate();
  return (
    <div className="main flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3">
      <p className="text-sm text-muted-foreground">无权限：管理页仅管理员可用。</p>
      <Button onClick={() => navigate("/")}>返回对话</Button>
    </div>
  );
}

function UserRow({ u, self, onReset, onChanged }: { u: AdminUserRow; self: boolean; onReset: () => void; onChanged: () => void }) {
  const deactivated = u.status === "deactivated";
  return (
    <tr className={`border-b border-border/50 last:border-0 hover:bg-accent/40 ${deactivated ? "opacity-50" : ""}`}>
      <td className="px-3 py-2">
        <span className="flex items-center gap-1.5">
          {deactivated ? <ProhibitIcon size={13} className="text-muted-foreground" /> : <CheckIcon size={13} className="text-emerald-600" />}
          {u.displayName ?? u.username}
          {self && <span className="rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">你</span>}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">@{u.username}</td>
      <td className="px-3 py-2 text-xs">{u.role}</td>
      <td className="px-3 py-2 text-xs">
        {deactivated ? <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">已停用</span> : <span className="text-emerald-600">active</span>}
      </td>
      <td className="px-3 py-2 text-right">
        {/* 自己不可停用/重置（防锁死——后端亦有守卫） */}
        {!self && (
          <span className="flex justify-end gap-1">
            {deactivated ? (
              <Button variant="outline" className="h-7 px-2 text-xs" onClick={() => void activateUser(u.id).then(onChanged)}>恢复</Button>
            ) : (
              <Button variant="outline" className="h-7 px-2 text-xs" onClick={() => void deactivateUser(u.id).then(onChanged)}>停用</Button>
            )}
            <Button variant="outline" className="h-7 px-2 text-xs" onClick={onReset}>重置密码</Button>
          </span>
        )}
      </td>
    </tr>
  );
}

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<string>(ROLE.member);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setUsername(""); setPassword(""); setDisplayName(""); setRole(ROLE.member); setErr(null);
    onClose();
  };

  const submit = async () => {
    if (!username.trim() || !password) return;
    setBusy(true); setErr(null);
    try {
      await createUser({ username: username.trim(), password, displayName: displayName.trim() || undefined, role });
      onCreated();
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={close} title="新建用户">
      <div className="flex flex-col gap-2">
        <input className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" placeholder="用户名（登录用）" value={username} onChange={(e) => setUsername(e.target.value)} data-testid="new-username" />
        <input className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" placeholder="初始密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" placeholder="显示名（可选）" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <select className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value={ROLE.member}>member</option>
          <option value={ROLE.admin}>admin</option>
        </select>
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={close}>取消</Button>
          <Button className="h-8 px-3 text-xs" disabled={busy || !username.trim() || !password} onClick={() => void submit()} data-testid="create-user">
            开通
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({ u, onClose, onDone }: { u: AdminUserRow | null; onClose: () => void; onDone: () => void }) {
  const [newPw, setNewPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!u || !newPw) return;
    setBusy(true); setErr(null);
    try {
      await resetPassword(u.id, newPw);
      setNewPw(""); onDone(); onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={u !== null} onClose={onClose} title={u ? `重置密码：${u.displayName ?? u.username}` : ""}>
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">重置后该用户全部会话断开，需用新密码重新登录。</p>
        <input className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" placeholder="新密码" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} data-testid="reset-pw" />
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" className="h-8 px-3 text-xs" onClick={onClose}>取消</Button>
          <Button className="h-8 px-3 text-xs" disabled={busy || !newPw} onClick={() => void submit()} data-testid="reset-pw-ok">确定</Button>
        </div>
      </div>
    </Dialog>
  );
}
