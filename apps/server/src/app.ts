// Hono app 工厂（DI：测试注入内存 store + stub runPi）。
import { Hono } from "hono";
import { createAuthMiddleware, type AppEnv } from "./auth/middleware";
import { registerAuthRoutes, registerUserRoutes } from "./auth/routes";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerWorkflowRoutes } from "./routes/workflows";
import { registerFeedbackRoutes } from "./routes/feedback";
import { registerConversationRoutes } from "./routes/conversations";
import { registerApprovalRoutes } from "./routes/approvals";
import type { RunDeps } from "./runs";

export function createApp(deps: RunDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // h5：body 上限（防超大 JSON 耗内存）。先于 auth 拒。
  const MAX_BODY = Number(process.env.MAX_BODY_BYTES ?? 64 * 1024);
  app.use("*", async (c, next) => {
    const cl = Number(c.req.header("content-length") ?? "0");
    if (cl > MAX_BODY) return c.json({ error: "request body too large" }, 413);
    return next();
  });
  app.use("*", createAuthMiddleware(deps.userStore));
  app.get("/health", (c) => c.json({ ok: true }));
  registerAuthRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerWorkflowRoutes(app, deps);
  registerFeedbackRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerApprovalRoutes(app, deps);
  return app;
}
