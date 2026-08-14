// 工作流/运行路由（runner 薄封装）。注册到主 app 的绝对路径，免 :id 前缀冲突。
// ADR-0018：起 run 走 resolveRequestWorkspace（缺省公司 ws）；读/续跑 run 可见性随其 workspace。
import type { Hono } from "hono";
import type { AppEnv } from "../auth/middleware";
import { principalOf } from "../auth/middleware";
import { listWorkflows } from "../registry";
import { startRun, resumeRun, WorkflowNotFound, RunNotFound, InvalidInput, type RunDeps } from "../runs";
import { InvalidWorkspaceId } from "../config";
import { canAccessWorkspace, resolveRequestWorkspace } from "../workspaces/guard";
import { PiBusy } from "../pi/runPi";
import { jsonBody } from "../http";

export function registerWorkflowRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  app.get("/workflows", (c) => c.json(listWorkflows()));

  app.post("/workflows/:id/runs", async (c) => {
    const id = c.req.param("id");
    const body = await jsonBody(c);
    if (body.projectId !== undefined) return c.json({ error: "projectId is gone; use workspaceId" }, 404); // 字段废止：显式拒绝；「dev」魔法默认已删（ADR-0018）
    // 缺省 → 公司 ws；提供则格式（400）→ 存在性/权限（404）。统一走 resolveRequestWorkspace（与 conversations 同口径）。
    const r = resolveRequestWorkspace(deps.workspaceStore, body.workspaceId, principalOf(c));
    if (!r.ok) return c.json({ error: r.error }, r.status);
    const input: unknown = body.input ?? {};
    try {
      return c.json(await startRun(deps, id, r.workspaceId, input));
    } catch (e) {
      if (e instanceof WorkflowNotFound) return c.json({ error: e.message }, 404);
      if (e instanceof InvalidWorkspaceId || e instanceof InvalidInput) return c.json({ error: e.message }, 400);
      if (e instanceof PiBusy) return c.json({ error: e.message }, 429);
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  app.post("/runs/:id/resume", async (c) => {
    const id = c.req.param("id");
    const body = await jsonBody(c);
    const run = deps.store.getRun(id);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (!canAccessWorkspace(deps.workspaceStore, run.workspaceId, principalOf(c))) {
      return c.json({ error: "run not found" }, 404);
    }
    try {
      return c.json(await resumeRun(deps, id, body.resumeData));
    } catch (e) {
      if (e instanceof RunNotFound) return c.json({ error: e.message }, 404);
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  app.get("/runs/:id", (c) => {
    const id = c.req.param("id");
    const run = deps.store.getRun(id);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (!canAccessWorkspace(deps.workspaceStore, run.workspaceId, principalOf(c))) {
      return c.json({ error: "run not found" }, 404);
    }
    return c.json({ run, log: deps.store.getLog(id) });
  });
}
