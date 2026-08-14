// 真 auth 中间件（ADR-0014，替旧 auth-stub）：先查真 token（落库 sha256）→ 命中活跃用户即放行；
// 回退 dev 逃生阀（env 判，语义同旧桩：AGENTANY_DEV_TOKEN 匹配 / 未设放行+warn）。
// /health 与 /auth/login 免鉴权（path-bypass）。
// AppEnv：app 级 Variables 类型——中间件置 user/token，路由类型安全读（替旧 as any 散用）。
import type { Context, MiddlewareHandler } from "hono";
import type { UserRole, UserStore } from "./store";

/** app 级 Variables：身份 + 当前 token，均由 auth 中间件置入。 */
export type AppEnv = { Variables: { user: { id: string; role: UserRole }; token?: string } };
export type AppContext = Context<AppEnv>;

const warned = { done: false };
const bearerOf = (h?: string): string | null => (h && h.startsWith("Bearer ") ? h.slice(7) : null);

/** 当前 userId（中间件已置）。/health 与 /auth/login bypass 不置、但二者不调用本函数。 */
export const userIdOf = (c: AppContext): string => c.var.user.id;
/** 当前 role（admin 守卫用）。 */
export const userRoleOf = (c: AppContext): UserRole => c.var.user.role;
/** 当前身份整体（workspace 守卫用；= c.var.user）。 */
export const principalOf = (c: AppContext): { id: string; role: UserRole } => c.var.user;

export function createAuthMiddleware(userStore: UserStore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/auth/login") return next();
    const tok = bearerOf(c.req.header("authorization"));
    if (tok) {
      const u = userStore.resolveToken(tok);
      if (u) {
        c.set("user", { id: u.id, role: u.role });
        c.set("token", tok);
        return next();
      }
    }
    // dev 逃生阀（env 判）
    const devTok = process.env.AGENTANY_DEV_TOKEN;
    const devId = process.env.AGENTANY_DEV_USER ?? "dev-user";
    if (!devTok) {
      if (!warned.done) {
        console.warn("[auth] AGENTANY_DEV_TOKEN 未设：dev 放行（勿公网暴露）");
        warned.done = true;
      }
      c.set("user", { id: devId, role: "admin" });
      return next();
    }
    if (tok === devTok) {
      c.set("user", { id: devId, role: "admin" });
      return next();
    }
    return c.json({ error: "unauthorized" }, 401);
  };
}
