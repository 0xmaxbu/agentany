// 工作流管理（#75 / ADR-0033 R-3）：列表（id/名称/描述/启停/授权人数）+ 启停开关 + 授权管理
// （搜索用户→加/撤授权）。渲染在 shell 中区（同 UsersPage 骨架）；API 见服务端 /admin/workflows/*。
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { apiFetch } from "../../api";
import { useAuth, ROLE } from "../../store/auth";
import { useTheme } from "../../lib/theme";
import { Button } from "../../components/ui/button";

const jsonHeaders = { "Content-Type": "application/json" };

export interface AdminWorkflowRow {
  id: string;
  name: string | null;
  description: string | null;
  enabled: boolean;
  grantCount: number;
  remoteTools: boolean;
}

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  return apiFetch(path, init);
}

const listWorkflows = async (): Promise<AdminWorkflowRow[]> => {
  const r = await adminFetch("/admin/workflows");
  if (!r.ok) throw new Error(`listWorkflows: ${r.status}`);
  return r.json();
};
const setEnabled = async (id: string, enabled: boolean) => {
  const r = await adminFetch(`/admin/workflows/${id}/config`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled }) });
  if (!r.ok) throw new Error(`config: ${r.status}`);
};
const listGrants = async (id: string): Promise<{ userId: string }[]> => {
  const r = await adminFetch(`/admin/workflows/${id}/grants`);
  if (!r.ok) throw new Error(`grants: ${r.status}`);
  return r.json();
};
const addGrant = async (wfId: string, userId: string) => {
  const r = await adminFetch(`/admin/workflows/${wfId}/grants`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ userId }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `grant: ${r.status}`);
};
const removeGrant = async (wfId: string, userId: string) => {
  await adminFetch(`/admin/workflows/${wfId}/grants/${userId}`, { method: "DELETE" });
};
const listUsers = async (): Promise<{ id: string; username: string }[]> => {
  const r = await adminFetch("/users");
  if (!r.ok) throw new Error(`users: ${r.status}`);
  return r.json();
};

interface GrantRow {
  userId: string;
  username: string;
}

function WorkflowRow({
  wf,
  users,
  onChanged,
}: {
  wf: AdminWorkflowRow;
  users: Map<string, string>; // userId → username
  onChanged: () => void;
}) {
  const [grants, setGrants] = useState<GrantRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadGrants = () => {
    void listGrants(wf.id)
      .then((gs) => setGrants(gs.map((g) => ({ userId: g.userId, username: users.get(g.userId) ?? g.userId }))))
      .catch((e) => setErr(String(e.message ?? e)));
  };
  useEffect(() => {
    setGrants(null);
    loadGrants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wf.id, users.size]);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const granted = new Set((grants ?? []).map((g) => g.userId));
    return [...users.entries()]
      .filter(([id, name]) => !granted.has(id) && (name.toLowerCase().includes(q) || wf.id.toLowerCase().includes(q)))
      .map(([id, name]) => ({ id, name }));
  }, [users, grants, search, wf.id]);

  const doAdd = async (userId: string) => {
    setBusy(true);
    setErr(null);
    try {
      await addGrant(wf.id, userId);
      setSearch("");
      loadGrants();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const doRemove = async (userId: string) => {
    setBusy(true);
    try {
      await removeGrant(wf.id, userId);
      loadGrants();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const doToggle = () => {
    setBusy(true);
    void setEnabled(wf.id, !wf.enabled).then(() => {
      setBusy(false);
      onChanged();
    });
  };

  return (
    <tr className="border-b border-border/50 align-top last:border-0 hover:bg-accent/40">
      <td className="px-3 py-2">
        <div className="text-sm font-medium">{wf.name ?? wf.id}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{wf.id}</div>
        {wf.description && <div className="mt-1 max-w-xs text-xs text-muted-foreground">{wf.description}</div>}
      </td>
      <td className="px-3 py-2 text-xs">
        <span className={`rounded-sm px-1.5 py-0.5 text-[10px] ${wf.enabled ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
          {wf.enabled ? "启用" : "停用"}
        </span>
      </td>
      <td className="px-3 py-2 text-xs">
        {wf.enabled ? (
          <Button variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={doToggle} data-testid={`disable-${wf.id}`}>
            停用
          </Button>
        ) : (
          <Button variant="outline" className="h-7 px-2 text-xs text-emerald-600" disabled={busy} onClick={doToggle} data-testid={`enable-${wf.id}`}>
            启用
          </Button>
        )}
      </td>
      <td className="px-3 py-2 text-xs">{wf.grantCount !== null ? wf.grantCount : "—"}</td>
      <td className="px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-1 pb-1.5">
          {(grants ?? []).map((g) => (
            <span key={g.userId} className="flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-foreground" data-testid={`grant-${g.userId}`}>
              @{g.username}
              <button className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => void doRemove(g.userId)} title="撤销授权">
                ✕
              </button>
            </span>
          ))}
          {(grants ?? []).length === 0 && <span className="text-[10px] text-muted-foreground">无授权（默认仅 admin 可跑）</span>}
        </div>
        <div className="relative">
          <input
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
            placeholder="搜用户名授权…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid={`grant-search-${wf.id}`}
          />
          {candidates.length > 0 && (
            <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-card shadow-md">
              {candidates.map((u) => (
                <button
                  key={u.id}
                  className="block w-full px-2 py-1 text-left text-xs hover:bg-accent"
                  disabled={busy}
                  onClick={() => void doAdd(u.id)}
                >
                  @{u.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {err && <p className="mt-1 text-[10px] text-destructive">{err}</p>}
      </td>
    </tr>
  );
}

export function AdminWorkflowsPage() {
  const [rows, setRows] = useState<AdminWorkflowRow[] | null>(null);
  const [users, setUsers] = useState<Map<string, string>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const isAdmin = status === "anonymous" || user?.role === ROLE.admin;
  const navigate = useNavigate();

  const reload = () => {
    void listWorkflows().then(setRows).catch((e) => setErr(String(e.message ?? e)));
    void listUsers()
      .then((us) => setUsers(new Map(us.map((u) => [u.id, u.username]))))
      .catch(() => setUsers(new Map())); // 用户列表失败不挡工作流表
  };
  useEffect(reload, []);

  if (!isAdmin) {
    return (
      <div className="main flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">无权限：管理页仅管理员可用。</p>
        <Button onClick={() => navigate("/")}>返回对话</Button>
      </div>
    );
  }

  return (
    <div className="main flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <h1 className="text-base font-semibold">工作流管理</h1>
        <ThemeToggle />
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        {err && <p className="mx-auto mb-4 max-w-3xl text-sm text-destructive">{err}</p>}
        {rows === null && <p className="text-sm text-muted-foreground">加载中…</p>}
        {rows !== null && (
          <div className="mx-auto max-w-4xl overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm" data-testid="workflows-table">
              <thead>
                <tr className="border-b border-border bg-secondary/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">工作流</th>
                  <th className="px-3 py-2 font-medium">启停</th>
                  <th className="px-3 py-2 font-medium">操作</th>
                  <th className="px-3 py-2 font-medium">授权人数</th>
                  <th className="px-3 py-2 font-medium">授权管理</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((wf) => (
                  <WorkflowRow key={wf.id} wf={wf} users={users} onChanged={reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
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