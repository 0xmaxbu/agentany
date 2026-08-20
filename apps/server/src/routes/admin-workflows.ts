// 工作流管理（ADR-0033 / R-3，admin-only）：列表（id/名称/描述/启停/授权人数）、启停开关、授权加撤。
// 复用现有 admin 路由风格（requireAdmin + 403）；数据面 = workflow registry + RemoteStore 三表
// （workflow_cfg.enabled / workflow_grants）。启停只拦新开（不影响进行中 run）——由 lifecycle preflight 消费。
import type { Hono } from "hono";
import type { RunDeps } from "../runs";
import { listWorkflows } from "../registry";
import { type AppContext, type AppEnv, userRoleOf } from "../auth/middleware";
import { jsonBody } from "../http";

const requireAdmin = (c: AppContext): Response | null => (userRoleOf(c) !== "admin" ? c.json({ error: "forbidden" }, 403) : null);

export function registerAdminWorkflowRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  const remote = () => deps.remote; // 未装配 → 503（同 im/task 惯例）

  app.get("/admin/workflows", (c) => {
    const f = requireAdmin(c);
    if (f) return f;
    const r = remote();
    if (!r) return c.json({ error: "remote store unavailable" }, 503);
    return c.json(
      listWorkflows().map((w) => ({
        id: w.id,
        name: w.name ?? null,
        description: w.description ?? null,
        enabled: r.getCfg(w.id).enabled,
        grantCount: r.grantCount(w.id),
        remoteTools: (w as any).tools?.some(() => true) ?? false, // 工作流声明了工具（remote 与否展示用）
      })),
    );
  });

  app.post("/admin/workflows/:id/config", async (c) => {
    const f = requireAdmin(c);
    if (f) return f;
    const r = remote();
    if (!r) return c.json({ error: "remote store unavailable" }, 503);
    const body = await jsonBody(c);
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled (boolean) required" }, 400);
    r.setEnabled(c.req.param("id"), body.enabled);
    return c.json({ ok: true, enabled: body.enabled });
  });

  app.post("/admin/workflows/:id/grants", async (c) => {
    const f = requireAdmin(c);
    if (f) return f;
    const r = remote();
    if (!r) return c.json({ error: "remote store unavailable" }, 503);
    const body = await jsonBody(c);
    const userId = body.userId;
    if (typeof userId !== "string" || userId.length === 0) return c.json({ error: "userId required" }, 400);
    if (!deps.userStore.getUserById(userId)) return c.json({ error: "user not found" }, 404);
    r.addGrant(c.req.param("id"), userId);
    return c.json({ ok: true, grantCount: r.grantCount(c.req.param("id")) });
  });

  app.get("/admin/workflows/:id/grants", (c) => {
    const f = requireAdmin(c);
    if (f) return f;
    const r = remote();
    if (!r) return c.json({ error: "remote store unavailable" }, 503);
    return c.json(r.listGrants(c.req.param("id")));
  });

  app.delete("/admin/workflows/:id/grants/:userId", (c) => {
    const f = requireAdmin(c);
    if (f) return f;
    const r = remote();
    if (!r) return c.json({ error: "remote store unavailable" }, 503);
    r.removeGrant(c.req.param("id"), c.req.param("userId"));
    return c.json({ ok: true, grantCount: r.grantCount(c.req.param("id")) });
  });
}