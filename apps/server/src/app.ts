// Hono app 工厂（DI：测试注入内存 store + stub runPi）。
import { Hono } from "hono";
import { createAuthMiddleware, type AppEnv } from "./auth/middleware";
import { registerAuthRoutes, registerUserRoutes } from "./auth/routes";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerWorkflowRoutes } from "./routes/workflows";
import { registerFeedbackRoutes } from "./routes/feedback";
import { registerConversationRoutes } from "./routes/conversations";
import { registerScheduledTaskRoutes } from "./routes/scheduled-tasks";
import { registerFileRoutes } from "./routes/files";
import { registerImRoutes } from "./routes/im";
import { registerDeviceAuthRoutes } from "./device/routes"; // ADR-0033/R-2：设备登录/登出
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
  registerDeviceAuthRoutes(app, deps); // ADR-0033/R-2：/auth/device-login（公开）+ /auth/device-logout
  registerUserRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerWorkflowRoutes(app, deps);
  registerFeedbackRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerScheduledTaskRoutes(app, deps); // #25：taskStore 未接线时路由自 500（ts() 守卫）——测试/prod 均已装配
  registerFileRoutes(app, deps); // #30：文件预览/下载（workspaceStore 必装——鉴权口径）
  registerImRoutes(app, deps); // #51/T2：IM 身份绑定管理（imStore 未装配时自 503——IM 立项后 prod 装配）
  return app;
}
