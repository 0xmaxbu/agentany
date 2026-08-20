// 设备认证路由（ADR-0033 / R-2）：设备用**用户账号**登录 → 长效 token（复用 auth_tokens 落库）。
// - POST /auth/device-login（公开，真鉴权）：校验口令（argon2 timingSafeVerify）→ issueToken → remote_clients upsert 联机。
//   **AGENTANY_DEV_TOKEN 不覆盖**——设备路径默认真鉴权（login 本身即校验真实口令）。
//   顶号不在本端点做：kick 在 WS connect 时刻（registry.register，同账号新连接挤旧连接），本端点只落库。
// - POST /auth/device-logout（需 token）：吊销该 token + 关在线连接（LOGOUT_REASON）+ 该用户 remote_clients 置离线。
import type { Hono } from "hono";
import type { RunDeps } from "../runs";
import { jsonBody } from "../http";
import { timingSafeVerify } from "../auth/store";
import { toPublic } from "../auth/routes";
import { type AppContext, type AppEnv, userIdOf } from "../auth/middleware";
import { LOGOUT_REASON } from "./registry";

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/; // 客户端生成并持久化；重连认作同机

export function registerDeviceAuthRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  const us = deps.userStore;

  app.post("/auth/device-login", async (c) => {
    const remote = deps.remote;
    if (!remote) return c.json({ error: "device store unavailable" }, 503);
    const body = await jsonBody(c);
    const username: unknown = body.username;
    const password: unknown = body.password;
    const deviceId: unknown = body.deviceId;
    const deviceName: unknown = body.deviceName;
    if (typeof username !== "string" || typeof password !== "string" || typeof deviceId !== "string") {
      return c.json({ error: "username, password and deviceId required" }, 400);
    }
    if (!DEVICE_ID_RE.test(deviceId)) {
      return c.json({ error: "invalid deviceId" }, 400);
    }
    const u = us.getUserByUsername(username);
    const hash = u && u.status === "active" ? u.passwordHash : null;
    const ok = await timingSafeVerify(password, hash); // 用户不存在/停用亦跑满 argon2（防枚举）
    if (!u || u.status !== "active" || !ok) return c.json({ error: "invalid credentials" }, 401);
    const token = await us.issueToken(u.id);
    remote.upsertClient({ userId: u.id, deviceId, deviceName: typeof deviceName === "string" ? deviceName : null });
    return c.json({ token, user: toPublic(u) }, 200);
  });

  app.post("/auth/device-logout", (c: AppContext) => {
    const tok = c.var.token;
    const userId = userIdOf(c);
    if (tok) us.revokeToken(tok);
    deps.deviceRegistry?.close(userId, LOGOUT_REASON); // 关在线 WS 连接（close handler 会反注册 + 置离线）
    const remote = deps.remote;
    if (remote) {
      for (const cl of remote.listClientsByUser(userId)) remote.setClientOffline(userId, cl.deviceId); // 兜底（连接已死时）
    }
    return c.json({ revoked: Boolean(tok) });
  });
}