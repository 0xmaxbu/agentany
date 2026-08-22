// 登录页（f2-4 接 ui 组件）：极简专业（skill 纪律——zinc 中性 + primary 单强调、无渐变无装饰、
// 表单对比度 AA、label 在输入上方、错误内联在输入下方、加载态禁用）。
import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { CircleNotch } from "@phosphor-icons/react";
import { useAuth } from "../store/auth";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

const IW = 1.5; // 图标线宽全局统一

export function LoginPage() {
  const status = useAuth((s) => s.status);
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 登录后回原来要去的地方（ProtectedRoute 传入 state.from）
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  // 已登录/匿名（dev 放行）→ 无需登录，直接回
  if (status === "authenticated" || status === "anonymous") {
    return <Navigate to={from} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await login(username, password);
    setBusy(false);
    if (r.ok) navigate(from, { replace: true });
    else setError(r.error ?? "登录失败");
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">agentany</h1>
          <p className="mt-2 text-sm text-muted-foreground">登录以继续</p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="用户名"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || !username || !password}>
            {busy ? (
              <span className="inline-flex items-center gap-1.5">
                <CircleNotch size={14} strokeWidth={IW} className="animate-spin" />
                登录中…
              </span>
            ) : (
              "登录"
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
