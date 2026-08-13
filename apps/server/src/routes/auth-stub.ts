import type { MiddlewareHandler } from "hono";

// h5：dev-token 闸。设了 AGENTANY_DEV_TOKEN 则要求 `Authorization: Bearer <token>`；未设则 dev 放行（warn，勿公网暴露）。
// 真 auth（session→角色→项目成员）在 auth 阶段接，届时立 ADR。/health 免鉴权（健康探针）。
const warned = { done: false };
export const authStub: MiddlewareHandler = async (c, next) => {
  if (c.req.path === "/health") return next();
  const tok = process.env.AGENTANY_DEV_TOKEN;
  if (tok) {
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${tok}`) return c.json({ error: "unauthorized" }, 401);
  } else if (!warned.done) {
    console.warn("[auth] AGENTANY_DEV_TOKEN 未设：dev 放行（勿公网暴露）");
    warned.done = true;
  }
  (c as any).set("user", { id: process.env.AGENTANY_DEV_USER ?? "dev-user" });
  await next();
};

/** dev 桩：从 auth-stub 塞的 c.var.user 派生 userId；真 auth 后由 session 派生。conversations/approvals 共用。 */
export function userIdOf(c: { var: Record<string, unknown> }): string {
  const u = c.var?.user as { id?: string } | undefined;
  return u?.id ?? "dev-user";
}

