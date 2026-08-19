// IM 路由（spec #49 决策 6 + #55/T5 修订）：绑定≠admin 专属——自助绑（Web 发码 → 私聊 `#bind` 消费），
// admin 只读列表 + 兜底强制解绑（离职/异常场景），不可新增绑定。
// 路由只做鉴权 + 转发 ImStore；业务（命令/发码消费/补发）在 im/dispatch.ts（handleImCommand）+ im/store.ts。
import type { Context, Hono } from "hono";
import { userIdOf, userRoleOf, type AppEnv } from "../auth/middleware";
import { ROLE } from "../auth/store";
import type { RunDeps } from "../runs";

/** admin + imStore 双守卫收敛点。返拒绝响应或 null（放行）。 */
const requireImAdmin = (c: Context<AppEnv>, deps: RunDeps): Response | null => {
  if (userRoleOf(c) !== ROLE.admin) return c.json({ error: "forbidden" }, 403);
  if (!deps.imStore) return c.json({ error: "im store not wired" }, 503);
  return null;
};

export function registerImRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  // 自助发码（T5）：任意已登录用户给自己发一次性绑定码（10min TTL，私聊 `#bind <code>` 消费）。
  app.post("/im/bind-codes", (c) => {
    if (!deps.imStore) return c.json({ error: "im store not wired" }, 503);
    const { code, expiresAt } = deps.imStore.issueBindCode(userIdOf(c));
    return c.json({ code, expiresAt, ttlSeconds: 10 * 60 });
  });

  // 列表（admin 只读）
  app.get("/im/bindings", (c) => {
    const deny = requireImAdmin(c, deps);
    if (deny) return deny;
    return c.json({ bindings: deps.imStore!.list() });
  });

  // 解绑（admin 兜底；幂等）——单向兜底，无新增通道
  app.delete("/im/bindings/:platform/:imUserId", (c) => {
    const deny = requireImAdmin(c, deps);
    if (deny) return deny;
    const platform = decodeURIComponent(c.req.param("platform"));
    const imUserId = decodeURIComponent(c.req.param("imUserId"));
    const ok = deps.imStore!.unbind(imUserId, platform);
    return ok ? c.json({ unbound: true }) : c.json({ unbound: false }, 404);
  });
}