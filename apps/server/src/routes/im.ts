// IM 管理路由（spec #49 决策 6；T2 #51）：imBindings 静态绑定——admin 专属（v1 无自助注册/解绑）。
// 路由只做鉴权 + 形状校验 + 转发 ImStore；回流的业务入口是 handleImInbound（纯函数，平台 webhook 调）。
import type { Hono } from "hono";
import { userRoleOf, type AppEnv } from "../auth/middleware";
import { ROLE } from "../auth/store";
import { jsonBody } from "../http";
import type { RunDeps } from "../runs";

export function registerImRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  // 列表（admin）
  app.get("/im/bindings", (c) => {
    if (userRoleOf(c) !== ROLE.admin) return c.json({ error: "forbidden" }, 403);
    if (!deps.imStore) return c.json({ error: "im store not wired" }, 503);
    return c.json({ bindings: deps.imStore.list() });
  });

  // 绑定（admin；幂等 upsert）
  app.post("/im/bindings", async (c) => {
    if (userRoleOf(c) !== ROLE.admin) return c.json({ error: "forbidden" }, 403);
    if (!deps.imStore) return c.json({ error: "im store not wired" }, 503);
    const body = await jsonBody(c);
    const { imUserId, platform, userId } = body as { imUserId?: unknown; platform?: unknown; userId?: unknown };
    if (typeof imUserId !== "string" || imUserId.length === 0) return c.json({ error: "imUserId required" }, 400);
    if (typeof platform !== "string" || platform.length === 0) return c.json({ error: "platform required" }, 400);
    if (typeof userId !== "string" || userId.length === 0) return c.json({ error: "userId required" }, 400);
    const row = deps.imStore.bind(imUserId, platform, userId);
    if (!row) return c.json({ error: "bind failed: user not found, or user already bound on this platform" }, 409);
    return c.json(row);
  });

  // 解绑（admin；幂等）
  app.delete("/im/bindings/:platform/:imUserId", (c) => {
    if (userRoleOf(c) !== ROLE.admin) return c.json({ error: "forbidden" }, 403);
    if (!deps.imStore) return c.json({ error: "im store not wired" }, 503);
    const platform = decodeURIComponent(c.req.param("platform"));
    const imUserId = decodeURIComponent(c.req.param("imUserId"));
    const ok = deps.imStore.unbind(imUserId, platform);
    return ok ? c.json({ unbound: true }) : c.json({ unbound: false }, 404);
  });
}