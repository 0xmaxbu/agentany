// 真 auth + 用户管理路由（ADR-0014，替 auth-stub 时代的「无 login」）。
// 公开：POST /auth/login；需 token：POST /auth/logout、GET /me、POST /me/password；
// admin：POST /users、GET /users、POST /users/:id/deactivate、POST /users/:id/reset-password。
// 吊销 token 后强断该用户已开 SSE（streamRegistry.abortUser）——不杀 run。
// TODO(#auth-rate-limit, ADR-0014 后续)：/auth/login 无限流/锁定，暴力破解防护待加。
import type { Hono } from "hono";
import type { RunDeps } from "../runs";
import { jsonBody } from "../http";
import { BadPassword, timingSafeVerify, UsernameTaken, type UserRow, type UserRole } from "./store";
import { type AppContext, type AppEnv, userIdOf, userRoleOf } from "./middleware";

const USERNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_PW = 8;
const pwError = (pw: string): string | null => (pw.length < MIN_PW ? `password too short (min ${MIN_PW})` : null);

const toPublic = (u: UserRow): Record<string, unknown> => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName ?? null,
  role: u.role,
  status: u.status,
  createdAt: u.createdAt,
});

export function registerAuthRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  const us = deps.userStore;
  const streams = deps.streamRegistry;

  // login 免鉴权（中间件 path-bypass）。时序拉平防用户名枚举（见 timingSafeVerify）。
  app.post("/auth/login", async (c) => {
    const body = await jsonBody(c);
    const username: unknown = body.username;
    const password: unknown = body.password;
    if (typeof username !== "string" || typeof password !== "string") return c.json({ error: "username and password required" }, 400);
    const u = us.getUserByUsername(username);
    const hash = u && u.status === "active" ? u.passwordHash : null;
    const ok = await timingSafeVerify(password, hash); // 用户不存在/停用也跑满 argon2，恒 false
    if (!u || u.status !== "active" || !ok) return c.json({ error: "invalid credentials" }, 401);
    const token = await us.issueToken(u.id);
    return c.json({ token, user: toPublic(u) }, 200);
  });

  app.post("/auth/logout", (c) => {
    const tok = c.var.token;
    let revoked = false;
    if (tok) {
      us.revokeToken(tok);
      revoked = true;
    }
    return c.json({ revoked });
  });

  app.get("/me", (c) => {
    const u = us.getUserById(userIdOf(c));
    if (!u) return c.json({ error: "user not found" }, 404);
    return c.json(toPublic(u));
  });

  // 改密（本人）：校验旧密码 → 设新 hash → 吊销除当前外全部 token → 断 SSE（当前会话靠重连自愈）。
  app.post("/me/password", async (c) => {
    const body = await jsonBody(c);
    const currentPassword: unknown = body.currentPassword;
    const newPassword: unknown = body.newPassword;
    if (typeof currentPassword !== "string") return c.json({ error: "currentPassword required" }, 400);
    if (typeof newPassword !== "string") return c.json({ error: "newPassword required" }, 400);
    const err = pwError(newPassword);
    if (err) return c.json({ error: err }, 400);
    const userId = userIdOf(c);
    const tok = c.var.token;
    try {
      const ok = await us.changePassword(userId, currentPassword, newPassword);
      if (!ok) return c.json({ error: "user not found" }, 404);
    } catch (e) {
      if (e instanceof BadPassword) return c.json({ error: "wrong current password" }, 403);
      throw e;
    }
    if (tok) us.revokeUserTokensExcept(userId, tok);
    streams.abortUser(userId);
    return c.json({ ok: true });
  });
}

export function registerUserRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  const us = deps.userStore;
  const streams = deps.streamRegistry;
  const requireAdmin = (c: AppContext): Response | null => (userRoleOf(c) !== "admin" ? c.json({ error: "forbidden" }, 403) : null);

  // 开通账号（admin）
  app.post("/users", async (c) => {
    const f = requireAdmin(c);
    if (f) return f;
    const body = await jsonBody(c);
    const username: unknown = body.username;
    const password: unknown = body.password;
    if (typeof username !== "string" || !USERNAME_RE.test(username)) return c.json({ error: "invalid username" }, 400);
    if (typeof password !== "string") return c.json({ error: "password required" }, 400);
    const err = pwError(password);
    if (err) return c.json({ error: err }, 400);
    const role: UserRole = body.role === "admin" ? "admin" : "member";
    const displayName = typeof body.displayName === "string" ? body.displayName : undefined;
    try {
      const u = await us.createUser({ username, password, displayName, role });
      return c.json(toPublic(u), 201);
    } catch (e) {
      if (e instanceof UsernameTaken) return c.json({ error: "username taken" }, 409);
      throw e;
    }
  });

  // 列全部用户（admin；不含 passwordHash）
  app.get("/users", (c) => {
    const f = requireAdmin(c);
    if (f) return f;
    return c.json(us.listUsers().map(toPublic));
  });

  // 注销账号（admin）：停用 + 删全部 token（store 内）+ 断 SSE。
  app.post("/users/:id/deactivate", (c) => {
    const f = requireAdmin(c);
    if (f) return f;
    const id = c.req.param("id");
    const ok = us.deactivateUser(id);
    if (!ok) return c.json({ error: "user not found" }, 404);
    streams.abortUser(id);
    return c.json({ ok: true });
  });

  // 恢复账号（f4，admin）：deactivate 逆。token 已在停用时吊销——恢复后用户重新登录。
  app.post("/users/:id/activate", (c) => {
    const f = requireAdmin(c);
    if (f) return f;
    const ok = us.activateUser(c.req.param("id"));
    if (!ok) return c.json({ error: "user not found" }, 404);
    return c.json({ ok: true });
  });

  // 重置密码（admin）：不需旧密码 → 设新 hash → 吊销该用户全部 token → 断 SSE（强制用新密码重登）。
  app.post("/users/:id/reset-password", async (c) => {
    const f = requireAdmin(c);
    if (f) return f;
    const id = c.req.param("id");
    const body = await jsonBody(c);
    const newPassword: unknown = body.newPassword;
    if (typeof newPassword !== "string") return c.json({ error: "newPassword required" }, 400);
    const err = pwError(newPassword);
    if (err) return c.json({ error: err }, 400);
    const ok = await us.resetPassword(id, newPassword);
    if (!ok) return c.json({ error: "user not found" }, 404);
    us.revokeUserTokens(id);
    streams.abortUser(id);
    return c.json({ ok: true });
  });
}
