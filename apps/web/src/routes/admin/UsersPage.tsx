// 用户管理（f4）：表格 + 搜索 + 新建/重置密码弹窗（页面默认仅表格）。渲染在 shell 中区。
// #62：绑定状态列（IM 绑定——admin 列表 + 兜底解绑，服务端 /im/bindings）。
import { useEffect, useMemo, useState } from "react";
import { apiFetch, listImBindings, unbindIm, type ImBinding } from "../../api";
import { useAuth, ROLE } from "../../store/auth";
import { CheckIcon, CircleNotchIcon, MagnifyingGlassIcon, ProhibitIcon } from "@phosphor-icons/react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog } from "../../components/ui/dialog";
import { ThemeToggle } from "../../components/ui/theme-toggle";
import { NoAccess } from "../../components/ui/no-access";

const jsonHeaders = { "Content-Type": "application/json" };

// 枚举本地化（chat-optimize）：admin/member、active/deactivated → 中文（原裸枚举直出）
const ROLE_LABEL: Record<string, string> = { admin: "管理员", member: "成员" };
const STATUS_LABEL: Record<string, string> = { active: "启用", deactivated: "已停用" };

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
  const [bindings, setBindings] = useState<ImBinding[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<AdminUserRow | null>(null);
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const isAdmin = status === "anonymous" || user?.role === ROLE.admin;

  const reload = () => {
    // bindings 列表失败不挡用户列表（im 未接线时 503——降级显示「—」）
    void listUsers().then(setUsers).catch((e) => setErr(String(e.message ?? e)));
    void listImBindings().then(setBindings).catch(() => setBindings(null));
  };
  useEffect(reload, []);

  // 搜索：username/displayName 不分大小写包含
  const filtered = useMemo(() => {
    if (!users) return null;
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.username.toLowerCase().includes(q) || (u.displayName ?? "").toLowerCase().includes(q));
  }, [users, query]);

  // userId → 绑定集映射（同用户可绑多平台 v1 单平台 feishu，结构留数组）
  const byUser = useMemo(() => {
    const m = new Map<string, ImBinding[]>();
    for (const b of bindings ?? []) m.set(b.userId, [...(m.get(b.userId) ?? []), b]);
    return m;
  }, [bindings]);

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
            <MagnifyingGlassIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-full py-1.5 pl-7 pr-2"
              placeholder="搜索用户名 / 显示名…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="user-search"
            />
          </div>
          <Button size="sm" onClick={() => setCreating(true)} data-testid="open-create-user">
            新建用户
          </Button>
        </div>

        {err && <p className="mx-auto mb-4 max-w-3xl text-sm text-destructive">{err}</p>}
        {filtered === null && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CircleNotchIcon size={14} className="animate-spin" />
            加载中…
          </p>
        )}
        {filtered !== null && (
          <div className="mx-auto max-w-3xl overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm" data-testid="users-table">
              <thead>
                <tr className="border-b border-border bg-secondary/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">用户</th>
                  <th className="px-3 py-2 font-medium">用户名</th>
                  <th className="px-3 py-2 font-medium">角色</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">IM 绑定</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <UserRow key={u.id} u={u} bindings={byUser.get(u.id) ?? []} self={u.id === user?.id} onReset={() => setResetting(u)} onChanged={reload} />
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground">{query ? "无匹配用户" : "暂无用户"}</td></tr>
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

const PLATFORM_TITLES: Record<string, string> = { feishu: "飞书", telegram: "Telegram" };

function UserRow({ u, bindings, self, onReset, onChanged }: { u: AdminUserRow; bindings: ImBinding[]; self: boolean; onReset: () => void; onChanged: () => void }) {
  const deactivated = u.status === "deactivated";
  const [unbindConfirming, setUnbindConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const doUnbind = async () => {
    if (bindings.length === 0) return;
    setBusy(true);
    try {
      // v1 单平台逐个清（先飞书；多平台后续扩展）
      for (const b of bindings) await unbindIm(b.platform, b.imUserId);
      setUnbindConfirming(false);
      onChanged();
    } catch {
      // 失败保持 confirm 态（可重试）
    } finally { setBusy(false); }
  };

  return (
    <tr className={`border-b border-border/50 last:border-0 hover:bg-accent/40 ${deactivated ? "opacity-50" : ""}`}>
      <td className="px-3 py-2">
        <span className="flex items-center gap-1.5">
          {deactivated ? <ProhibitIcon size={14} className="text-muted-foreground" /> : <CheckIcon size={14} className="text-success" />}
          {u.displayName ?? u.username}
          {self && <span className="rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">你</span>}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">@{u.username}</td>
      <td className="px-3 py-2 text-xs">{ROLE_LABEL[u.role] ?? u.role}</td>
      <td className="px-3 py-2 text-xs">
        {deactivated ? <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">已停用</span> : <span className="text-success">{STATUS_LABEL[u.status] ?? u.status}</span>}
      </td>
      <td className="px-3 py-2 text-xs">
        {bindings.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1">
            {bindings.map((b) => (
              <span key={`${b.platform}:${b.imUserId}`} className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-foreground" title={b.imUserId}>
                {PLATFORM_TITLES[b.platform] ?? b.platform}
                <span className="ml-1 text-muted-foreground">{b.imUserId.slice(0, 6)}…</span>
              </span>
            ))}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {/* 自己不可停用/重置（防锁死——后端亦有守卫）；停用一点即执行（e2e 契约，无二次确认） */}
        {!self && (
          <span className="flex justify-end gap-1">
            {deactivated ? (
              <Button variant="outline" size="xs" onClick={() => void activateUser(u.id).then(onChanged)}>恢复</Button>
            ) : (
              <Button variant="outline" size="xs" onClick={() => void deactivateUser(u.id).then(onChanged)}>停用</Button>
            )}
            <Button variant="outline" size="xs" onClick={onReset}>重置密码</Button>
            {bindings.length > 0 &&
              (unbindConfirming ? (
                <Button variant="destructive" size="xs" disabled={busy} onClick={() => void doUnbind()} data-testid="unbind-im-confirm">
                  {busy ? "解绑中…" : "确认解绑"}
                </Button>
              ) : (
                <Button variant="outline" size="xs" onClick={() => setUnbindConfirming(true)} data-testid="unbind-im">
                  解绑
                </Button>
              ))}
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
        <Input className="py-1.5" placeholder="用户名（登录用）" value={username} onChange={(e) => setUsername(e.target.value)} data-testid="new-username" />
        <Input className="py-1.5" placeholder="初始密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Input className="py-1.5" placeholder="显示名（可选）" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <select className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value={ROLE.member}>{ROLE_LABEL[ROLE.member]}</option>
          <option value={ROLE.admin}>{ROLE_LABEL[ROLE.admin]}</option>
        </select>
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={close}>取消</Button>
          <Button size="sm" disabled={busy || !username.trim() || !password} onClick={() => void submit()} data-testid="create-user">
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
        <Input className="py-1.5" placeholder="新密码" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} data-testid="reset-pw" />
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={busy || !newPw} onClick={() => void submit()} data-testid="reset-pw-ok">确定</Button>
        </div>
      </div>
    </Dialog>
  );
}
