// 定时任务路由（#25/ADR-0021 切片 1）：建任务 tracer——POST 建 + GET 列表（权限分野）。
// #26 起补：PATCH/enable/DELETE/run/runs/view（管理闭环）。产出会话事务在 taskStore.createWorkspaceTask。
import type { Hono } from "hono";
import type { RunDeps } from "../runs";
import { userRoleOf, principalOf, userIdOf, type AppEnv } from "../auth/middleware";
import { resolveRequestWorkspace } from "../workspaces/guard";
import { InvalidCron, TooFrequent, validateCronAndFirstFire } from "../scheduled-tasks/cron";
import type { ScheduledTaskRow } from "../scheduled-tasks/store";
import { jsonBody } from "../http";

const toTask = (t: ScheduledTaskRow): Record<string, unknown> => ({
  id: t.id, scope: t.scope, workspaceId: t.workspaceId, displayName: t.displayName,
  cron: t.cron, prompt: t.prompt, outputConversationId: t.outputConversationId,
  creatorId: t.creatorId, nextFireAt: t.nextFireAt, enabled: t.enabled, createdAt: t.createdAt,
});

export function registerScheduledTaskRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  const ts = () => {
    const s = deps.taskStore;
    if (!s) throw new Error("taskStore not wired (deps.taskStore)");
    return s;
  };

  // 建（#24 故事 1/2/11）：登录即可（member 自建自批，ADR-0021 决策 5——无 admin 审批步）。
  // CommandPolicy 门在切片 2 的 bridge 层（LLM 建流）；API 层此处只挡格式/频率/scope。
  app.post("/scheduled-tasks", async (c) => {
    const body = await jsonBody(c);
    const displayName: unknown = body.displayName;
    const cron: unknown = body.cron;
    const prompt: unknown = body.prompt;
    if (typeof displayName !== "string" || displayName.length === 0) return c.json({ error: "displayName required" }, 400);
    if (typeof prompt !== "string" || prompt.length === 0) return c.json({ error: "prompt required" }, 400);
    if (typeof cron !== "string") return c.json({ error: "cron required" }, 400);
    if (body.scope === "system") return c.json({ error: "system tasks are seeded, not created via API" }, 403);
    // ws 解析与建会话同口径：缺省公司 ws；提供则格式→存在性/权限。
    const r = resolveRequestWorkspace(deps.workspaceStore, body.workspaceId, principalOf(c));
    if (!r.ok) return c.json({ error: r.error }, r.status);
    let firstFire: string;
    try {
      firstFire = validateCronAndFirstFire(cron);
    } catch (e) {
      if (e instanceof TooFrequent) return c.json({ error: "cron too frequent: minimum interval is 1h" }, 422);
      if (e instanceof InvalidCron) return c.json({ error: "invalid cron expression" }, 400);
      throw e;
    }
    const task = ts().createWorkspaceTask({
      displayName, cron, prompt,
      workspaceId: r.workspaceId, creatorId: userIdOf(c),
      firstFireAt: firstFire,
    });
    return c.json(toTask(task), 201);
  });

  // 列表（#24 故事 3/6）：member 只见自己的（system seed 剔除）；admin 全量（含 system）+ 未读数。
  app.get("/scheduled-tasks", (c) => {
    const isAdmin = userRoleOf(c) === "admin";
    const list = ts().listTasks(isAdmin ? {} : { creatorId: userIdOf(c), includeSystem: false });
    const unread = ts().unreadCounts();
    return c.json(list.map((t) => ({ ...toTask(t), unreadRuns: unread.get(t.id) ?? 0 })));
  });
}
