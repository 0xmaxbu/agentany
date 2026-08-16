// 定时任务路由（#25 建任务 tracer + #26 手动调用 + #27 管理闭环）。
// 权限口径：member=自己的任务（他人 404 不泄漏）；system 任务 member 一律 403 硬拒
// （ADR-0021 决策 7——chat LLM 删/停蒸馏同样被这道服务端闸挡住）；admin 全量可管。
import type { Context } from "hono";
import type { Hono } from "hono";
import type { RunDeps } from "../runs";
import { userRoleOf, principalOf, userIdOf, type AppEnv } from "../auth/middleware";
import { resolveRequestWorkspace } from "../workspaces/guard";
import { InvalidCron, TooFrequent, validateCronAndFirstFire } from "../scheduled-tasks/cron";
import { SystemTaskProtected, type ScheduledTaskRow, type TaskRunRow } from "../scheduled-tasks/store";
import { jsonBody } from "../http";

const toTask = (t: ScheduledTaskRow): Record<string, unknown> => ({
  id: t.id, scope: t.scope, workspaceId: t.workspaceId, displayName: t.displayName,
  cron: t.cron, prompt: t.prompt, outputConversationId: t.outputConversationId,
  creatorId: t.creatorId, nextFireAt: t.nextFireAt, enabled: t.enabled, createdAt: t.createdAt,
});

/** 任务可见性：admin 全量；member 仅 creatorId=自己（system 行对 member 一律不可见——含 seed）。 */
const canSeeTask = (t: ScheduledTaskRow, u: { id: string; role: "admin" | "member" }): boolean =>
  u.role === "admin" || (t.scope !== "system" && t.creatorId === u.id);

/** cron 校验统一出口：TooFrequent→422 / InvalidCron→400；合法返首个火点。 */
const cronErrorResponse = (e: unknown, c: Context<AppEnv>): Response | null => {
  if (e instanceof TooFrequent) return c.json({ error: "cron too frequent: minimum interval is 1h" }, 422);
  if (e instanceof InvalidCron) return c.json({ error: "invalid cron expression" }, 400);
  return null;
};

export function registerScheduledTaskRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  const ts = () => {
    const s = deps.taskStore;
    if (!s) throw new Error("taskStore not wired (deps.taskStore)");
    return s;
  };

  /** 载入+可见性；失败直接给错误响应（system+member=403 硬拒优先于不泄漏，seed id 非秘密）。 */
  const loadTask = (c: Context<AppEnv>): { task?: ScheduledTaskRow; err?: Response } => {
    const u = principalOf(c);
    const id = c.req.param("id")!;
    const t = ts().getTask(id);
    if (!t) return { err: c.json({ error: "task not found" }, 404) };
    if (t.scope === "system" && u.role !== "admin") return { err: c.json({ error: "system task protected" }, 403) };
    if (!canSeeTask(t, u)) return { err: c.json({ error: "task not found" }, 404) };
    return { task: t };
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
      const errRes = cronErrorResponse(e, c);
      if (errRes) return errRes;
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

  // 手动调用（#26/spec 故事 4/7）：立即执行一次。不经 tick——不推进 nextFireAt；在跑 409。
  app.post("/scheduled-tasks/:id/run", (c) => {
    const { task, err } = loadTask(c);
    if (!task) return err!;
    if (!deps.scheduler) return c.json({ error: "scheduler not wired" }, 503);
    const runId = deps.scheduler.runManual(task);
    if (runId === undefined) return c.json({ error: "task already running" }, 409);
    return c.json({ accepted: true, runId }, 202);
  });

  // ── #27 管理闭环 ──

  // 执行历史（#24 故事 5）：状态/触发/起止/产出引用。admin 任意（含 system 日志）；member 自己的。
  app.get("/scheduled-tasks/:id/runs", (c) => {
    const { task, err } = loadTask(c);
    if (!task) return err!;
    const runs: TaskRunRow[] = ts().listRuns(task.id);
    return c.json(runs);
  });

  // 点开即清（#24 故事 9）：该任务 viewedAt 批量盖章 → unreadCounts 归零。system 任务 admin 专用。
  app.post("/scheduled-tasks/:id/view", (c) => {
    const { task, err } = loadTask(c);
    if (!task) return err!;
    ts().markTaskRunsViewed(task.id);
    return c.json({ viewed: true });
  });

  // 改任务（#24 故事「对话改任务」的 API 面；切片 2 chat 流复用）：cron 变更重算 nextFireAt。
  // system 拒改（admin 也不行——只许停/启/删，内容是代码 seed 的真相）。
  app.patch("/scheduled-tasks/:id", async (c) => {
    const { task, err } = loadTask(c);
    if (!task) return err!;
    if (task.scope === "system") return c.json({ error: "system tasks cannot be edited" }, 403);
    const body = await jsonBody(c);
    const patch: { displayName?: string; cron?: string; prompt?: string } = {};
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== "string" || body.displayName.length === 0) return c.json({ error: "invalid displayName" }, 400);
      patch.displayName = body.displayName;
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== "string" || body.prompt.length === 0) return c.json({ error: "invalid prompt" }, 400);
      patch.prompt = body.prompt;
    }
    if (body.cron !== undefined) {
      if (typeof body.cron !== "string") return c.json({ error: "invalid cron" }, 400);
      try {
        validateCronAndFirstFire(body.cron); // 复用建时口径：合法 + 频率下限
      } catch (e) {
        const errRes = cronErrorResponse(e, c);
        if (errRes) return errRes;
        throw e;
      }
      patch.cron = body.cron;
    }
    if (Object.keys(patch).length === 0) return c.json({ error: "nothing to update" }, 400);
    ts().updateTask(task.id, patch);
    if (patch.cron) ts().recomputeNextFire(task.id); // cron 变了才重算（displayName/prompt 不动调度）
    return c.json(toTask(ts().getTask(task.id)!));
  });

  // 停/启（#24 故事 8）：member 自己的；system 仅 admin（allowSystem）。
  app.patch("/scheduled-tasks/:id/enable", async (c) => {
    const u = principalOf(c);
    const { task, err } = loadTask(c);
    if (!task) return err!;
    const body = await jsonBody(c);
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled (boolean) required" }, 400);
    try {
      const row = ts().setTaskEnabled(task.id, body.enabled, u.role === "admin");
      return c.json(toTask(row!));
    } catch (e) {
      if (e instanceof SystemTaskProtected) return c.json({ error: "system task protected" }, 403);
      throw e;
    }
  });

  // 删（#24 故事 8）：member 自己的（runs/files 级联清）；system 仅 admin。
  app.delete("/scheduled-tasks/:id", (c) => {
    const u = principalOf(c);
    const { task, err } = loadTask(c);
    if (!task) return err!;
    try {
      const ok = ts().deleteTask(task.id, u.role === "admin");
      return ok ? c.json({ deleted: true }) : c.json({ error: "task not found" }, 404);
    } catch (e) {
      if (e instanceof SystemTaskProtected) return c.json({ error: "system task protected" }, 403);
      throw e;
    }
  });
}
