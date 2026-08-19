// bridge：pi 子进程 → 服务端的薄 RPC 通道（#11 骨架 / #14 /run/* / #16 HITL /ask_user + /run/resume
// / #28 /task/* 定时任务工具——create 出任务卡（kind=task），list/update/delete/enable 管理面）。
// 独立 Hono on loopback:BRIDGE_PORT（默认 3199），全局 per-turn nonce 中间件（Authorization: Bearer）。
// 仅绑 127.0.0.1 + nonce 闸：只有本机持有效 nonce 的 pi 子进程能调。
import { Hono } from "hono";
import { verifyNonce, nonceConversation } from "./nonce";
import type { RunLifecycle } from "../runs/lifecycle";
import type { RunsStore } from "../runs/store"; // ADR-0030：bridge 只学三域面（run/hitl/chat）
import type { HitlStore } from "../hitl/store";
import type { ChatStore } from "../chat/store";
import type { EventBus, Frame } from "../chat/eventbus";
import type { ResumeOutcome } from "../workflow-engine/runner";
import type { UserStore } from "../auth/store";
import type { ScheduledTaskStore } from "../scheduled-tasks/store";
import { validateCronAndFirstFire, InvalidCron, TooFrequent } from "../scheduled-tasks/cron";
import { decide } from "../security/policy";
import { jsonBody } from "../http";

export const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 3199);

// bridge 通道三元组（ticket #11）：port/nonce/url 总是一起走 → 单一类型（Data Clump 修）。
export interface BridgeChannel {
  port: number;
  nonce: string;
  url: string;
}

function bearerToken(auth: string | undefined): string | null {
  return auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

export interface BridgeDeps {
  runLifecycle?: RunLifecycle;
  runStore?: RunsStore; // /run/*（读 run 跨会话 guard）
  hitlStore?: HitlStore; // /ask_user /ask_answer /task/*（卡 CRUD）
  chatStore?: ChatStore; // taskCtx（nonce→conv）
  eventBus?: EventBus;
  userStore?: UserStore; // #28：nonce→conv→userId→role（任务工具权限分野）
  taskStore?: ScheduledTaskStore; // #28：/task/* 端点
}

export function createBridgeApp(opts: BridgeDeps = {}): Hono {
  const app = new Hono();
  const { runLifecycle: reg, runStore, hitlStore, chatStore, eventBus, userStore, taskStore } = opts;

  // 全局 nonce 闸：所有路由需 Authorization: Bearer <有效未吊销 nonce>。缺/坏 → 401。
  app.use("*", async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !verifyNonce(token)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/ping", (c) => c.json({ ok: true, service: "agentany-bridge" }));

  // /run/start：start_workflow 工具经此。nonce → conversationId → runRegistry.start。
  app.post("/run/start", async (c) => {
    if (!reg) return c.json({ error: "run registry unavailable" }, 503);
    const conversationId = nonceConversation(bearerToken(c.req.header("authorization"))!);
    if (!conversationId) return c.json({ error: "no conversation for nonce" }, 400);
    const body = await jsonBody(c);
    const { workflowId, input } = body as { workflowId?: string; input?: unknown };
    if (!workflowId) return c.json({ error: "workflowId required" }, 400);
    try {
      return c.json(await reg.start({ conversationId, workflowId, input: input ?? {} }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // /run/read：read_run 工具经此。跨会话 guard（同 /ask_user /run/resume）：nonce 仅授权本会话，不得读他 conv 的 run。
  app.get("/run/read", (c) => {
    if (!reg || !runStore) return c.json({ error: "run registry unavailable" }, 503);
    const convId = nonceConversation(bearerToken(c.req.header("authorization"))!);
    if (!convId) return c.json({ error: "no conversation for nonce" }, 400);
    const runId = c.req.query("runId");
    if (!runId) return c.json({ error: "runId required" }, 400);
    const run = runStore.getRun(runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (run.conversationId !== convId) return c.json({ error: "forbidden" }, 403); // 跨会话 guard
    const r = reg.read(runId);
    if (!r) return c.json({ error: "run not found" }, 404);
    return c.json(r);
  });

  // /ask_user（#16 + ADR-0025 决策 7，#47/T5 → code-review 收紧）：ask_user 工具经此，**仅建自主卡**。
  // 自主卡：runId null、无 resume 语义（LLM 任何时候不确定即问；点选滑 LLM 轮归一化）。
  // run 绑定卡归引擎——挂起同事务直建，bridge 一律拒（旧「runId 补卡 + suspended/already_asked」路径已退役，
  // 产品未发布零兼容）。立即返 {asked}（不阻塞 turn）。
  app.post("/ask_user", async (c) => {
    if (!hitlStore || !eventBus) return c.json({ error: "hitl unavailable" }, 503);
    const convId = nonceConversation(bearerToken(c.req.header("authorization"))!);
    if (!convId) return c.json({ error: "no conversation for nonce" }, 400);
    const body = await jsonBody(c);
    const { runId, prompt, options, resumeSchema, multiple } = body as { runId?: string; prompt?: string; options?: string[]; resumeSchema?: unknown; multiple?: boolean };
    if (runId) return c.json({ error: "run-bound ask cards are engine-created on suspend; call ask_user without runId for an autonomous card" }, 400);
    if (typeof prompt !== "string" || !Array.isArray(options)) return c.json({ error: "prompt, options required" }, 400);
    const id = hitlStore.createQuestion({ conversationId: convId, runId: null, prompt, options, resumeSchema, multiple, kind: "ask" });
    const frame: Frame = { type: "hitl_request", questionId: id, runId: null, prompt, options, resumeSchema, multiple: multiple ? 1 : 0, kind: "ask" };
    eventBus.publish(convId, frame);
    return c.json({ status: "asked", questionId: id });
  });

  // /ask_answer（ADR-0025 决策 10 修订）：自主卡打字答案的收口通道——pi 归一化后落卡（对应 run 绑定卡的 /run/resume）。
  // 仅自主卡（kind=ask 且 runId null）；run 绑定卡答案走 resume_workflow（resume 语义）。
  app.post("/ask_answer", async (c) => {
    if (!hitlStore || !eventBus) return c.json({ error: "hitl unavailable" }, 503);
    const convId = nonceConversation(bearerToken(c.req.header("authorization"))!);
    if (!convId) return c.json({ error: "no conversation for nonce" }, 400);
    const body = await jsonBody(c);
    const { questionId, answer } = body as { questionId?: number; answer?: unknown };
    if (typeof questionId !== "number") return c.json({ error: "questionId required" }, 400);
    const q = hitlStore.getQuestion(questionId);
    if (!q || q.conversationId !== convId) return c.json({ error: "question not found" }, 404); // 含跨会话（nonce 只授权本会话）
    if (q.kind !== "ask" || q.runId) {
      return c.json({ error: "only autonomous ask cards use answer_question; run-bound cards resume via resume_workflow" }, 409);
    }
    if (q.status !== "pending") return c.json({ status: "alreadyAnswered" }); // 幂等
    hitlStore.markQuestionAnswered(questionId, answer);
    eventBus.publish(convId, { type: "hitl_answered", questionId, kind: "ask", answer });
    return c.json({ status: "answered" });
  });

  // /run/resume（#16）：resume_workflow 工具经此。registry.resume 三态分支；clean→markAnswered + 推 hitl_answered。
  app.post("/run/resume", async (c) => {
    if (!reg) return c.json({ error: "run registry unavailable" }, 503);
    const convId = nonceConversation(bearerToken(c.req.header("authorization"))!);
    if (!convId) return c.json({ error: "no conversation for nonce" }, 400);
    const body = await jsonBody(c);
    const { runId, resumeData } = body as { runId?: string; resumeData?: unknown };
    if (!runId) return c.json({ error: "runId required" }, 400);
    const run = runStore?.getRun(runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (run.conversationId !== convId) return c.json({ error: "forbidden" }, 403);
    let outcome: ResumeOutcome;
    try {
      outcome = await reg.resume(runId, resumeData);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if ("rejected" in outcome) return c.json({ error: outcome.error }, 409); // schema 校验失败，保持 pending
    if ("idempotent" in outcome) return c.json({ alreadyAnswered: true }); // 已答，no-op
    // clean（ADR-0025 决策 11：即时返 running，续跑 detached）→ 答案已确定性派发：标 pending answered + 推 hitl_answered
    const row = hitlStore?.markPendingAnsweredByRun(runId, resumeData);
    if (row && eventBus) eventBus.publish(convId, { type: "hitl_answered", questionId: row.id, answer: resumeData });
    return c.json({ status: outcome.status });
  });

  // ── #28 定时任务工具（/task/*）──
  // 身份：nonce→conv→conv.userId；角色经 userStore。member=自己的任务；system 只读（list 仅 admin
  // 可见 system 行；写操作对 system 一律 403——admin 经工具同样拒，管理只走 admin UI，ADR-0021 决策 7）。

  const taskCtx = (c: { req: { header: (n: string) => string | undefined } }) => {
    const convId = nonceConversation(bearerToken(c.req.header("authorization"))!);
    if (!convId) return { err: 400 as const };
    const conv = chatStore?.getConversation(convId);
    const user = userStore?.getUserById(conv?.userId ?? "");
    if (!conv || !user) return { err: 403 as const };
    return { convId, userId: user.id, role: user.role };
  };

  /** 任务卡 prompt：displayName + cron 人类可读 + 未来 3 次执行时间 + 目标。 */
  const taskCardPrompt = (p: { displayName: string; cron: string; prompt: string }, next3: string[]) =>
    `创建定时任务「${p.displayName}」？频率：${p.cron}（未来 3 次执行：${next3.map((t) => new Date(t).toLocaleString("zh-CN")).join("；")}）。任务目标：${p.prompt}`;

  // /task/create：校验（cron 合法+频率下限+CommandPolicy）→ 出 kind=task pending 卡（input=完整参数+next3）。
  // 确认不经此（ADR-0022）：用户点选项=发消息绑卡（inReplyTo）→ hitl-dispatch 确定性直建，参数零漂移。
  app.post("/task/create", async (c) => {
    if (!hitlStore || !taskStore) return c.json({ error: "task tools unavailable" }, 503);
    const ctx2 = taskCtx(c);
    if ("err" in ctx2) return c.json({ error: "no identity for nonce" }, ctx2.err);
    const body = await jsonBody(c);
    const { displayName, cron, prompt } = body as { displayName?: string; cron?: string; prompt?: string };
    if (typeof displayName !== "string" || !displayName || typeof prompt !== "string" || !prompt || typeof cron !== "string") {
      return c.json({ error: "displayName, cron, prompt required" }, 400);
    }
    // CommandPolicy（deny-only 语义）：deny → 拒建；require_approval/allow → 出卡（自建自批，ADR-0021 修订）
    const verdict = decide("scheduled-task");
    if (verdict.decision === "deny") return c.json({ error: `denied by command policy: ${verdict.reason}` }, 403);
    let next3: string[];
    try {
      const first = validateCronAndFirstFire(cron);
      // 未来 3 次：parse 后连取（firstFire + 后续 2 个）
      const { CronExpressionParser } = await import("cron-parser");
      const it = CronExpressionParser.parse(cron, { currentDate: new Date() });
      next3 = [it.next().toDate().toISOString(), it.next().toDate().toISOString(), it.next().toDate().toISOString()];
      void first;
    } catch (e) {
      if (e instanceof TooFrequent) return c.json({ error: "cron too frequent: minimum interval is 1h — 请重新解析用户的频率需求" }, 422);
      if (e instanceof InvalidCron) return c.json({ error: "invalid cron expression" }, 400);
      throw e;
    }
    const id = hitlStore.createQuestion({
      conversationId: ctx2.convId, kind: "task",
      prompt: taskCardPrompt({ displayName, cron, prompt }, next3),
      options: ["确认创建", "取消"],
      input: { displayName, cron, prompt, next3 }, // 完整参数暂存卡上——确认时服务端直建（零 LLM 二跳）
    });
    eventBus?.publish(ctx2.convId, { type: "hitl_request", questionId: id, runId: null, kind: "task", prompt: taskCardPrompt({ displayName, cron, prompt }, next3), options: ["确认创建", "取消"], multiple: 0 });
    return c.json({ status: "asked", questionId: id });
  });

  // /task/list：member 自己的（剔 system）；admin 全量（含 system——工具层只读可见）。
  app.get("/task/list", (c) => {
    if (!taskStore) return c.json({ error: "task tools unavailable" }, 503);
    const ctx2 = taskCtx(c);
    if ("err" in ctx2) return c.json({ error: "no identity for nonce" }, ctx2.err);
    const list = ctx2.role === "admin"
      ? taskStore.listTasks({})
      : taskStore.listTasks({ creatorId: ctx2.userId, includeSystem: false });
    return c.json(list);
  });

  // /task/update：改 cron/prompt/displayName → 出新任务卡（确认后服务端 updateTask + recomputeNextFire）。
  app.post("/task/update", async (c) => {
    if (!hitlStore || !taskStore) return c.json({ error: "task tools unavailable" }, 503);
    const ctx2 = taskCtx(c);
    if ("err" in ctx2) return c.json({ error: "no identity for nonce" }, ctx2.err);
    const body = await jsonBody(c);
    const { taskId, ...patch } = body as { taskId?: string; cron?: string; prompt?: string; displayName?: string };
    if (!taskId || typeof taskId !== "string") return c.json({ error: "taskId required" }, 400);
    const task = taskStore.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    if (task.scope === "system") return c.json({ error: "system tasks are read-only via chat (admin UI only)" }, 403);
    if (ctx2.role !== "admin" && task.creatorId !== ctx2.userId) return c.json({ error: "task not found" }, 404);
    if (patch.cron !== undefined) {
      try {
        validateCronAndFirstFire(patch.cron);
      } catch (e) {
        if (e instanceof TooFrequent) return c.json({ error: "cron too frequent: minimum interval is 1h" }, 422);
        if (e instanceof InvalidCron) return c.json({ error: "invalid cron expression" }, 400);
        throw e;
      }
    }
    const next = { ...task, ...patch } as typeof task;
    const id = hitlStore.createQuestion({
      conversationId: ctx2.convId, kind: "task",
      prompt: `修改定时任务「${task.displayName}」？新配置：${patch.cron ?? task.cron} / ${patch.displayName ?? task.displayName}。目标：${patch.prompt ?? task.prompt}`,
      options: ["确认修改", "取消"],
      input: { update: { taskId, patch } },
    });
    eventBus?.publish(ctx2.convId, { type: "hitl_request", questionId: id, runId: null, kind: "task", prompt: `修改任务「${task.displayName}」`, options: ["确认修改", "取消"], multiple: 0 });
    void next;
    return c.json({ status: "asked", questionId: id });
  });

  // /task/delete：member 自己的（system 一律 403 含 admin）。
  app.post("/task/delete", async (c) => {
    if (!taskStore) return c.json({ error: "task tools unavailable" }, 503);
    const ctx2 = taskCtx(c);
    if ("err" in ctx2) return c.json({ error: "no identity for nonce" }, ctx2.err);
    const body = await jsonBody(c);
    const taskId = (body as { taskId?: string }).taskId;
    if (!taskId) return c.json({ error: "taskId required" }, 400);
    const task = taskStore.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    if (task.scope === "system") return c.json({ error: "system tasks are read-only via chat (admin UI only)" }, 403);
    if (ctx2.role !== "admin" && task.creatorId !== ctx2.userId) return c.json({ error: "task not found" }, 404);
    const ok = taskStore.deleteTask(taskId, false); // allowSystem=false：工具层对 system 永拒（上面已挡，双保险）
    return ok ? c.json({ deleted: true }) : c.json({ error: "task not found" }, 404);
  });

  // /task/enable：member 自己的停/启（system 一律 403 含 admin）。
  app.post("/task/enable", async (c) => {
    if (!taskStore) return c.json({ error: "task tools unavailable" }, 503);
    const ctx2 = taskCtx(c);
    if ("err" in ctx2) return c.json({ error: "no identity for nonce" }, ctx2.err);
    const body = await jsonBody(c);
    const { taskId, enabled } = body as { taskId?: string; enabled?: boolean };
    if (!taskId || typeof enabled !== "boolean") return c.json({ error: "taskId, enabled (boolean) required" }, 400);
    const task = taskStore.getTask(taskId);
    if (!task) return c.json({ error: "task not found" }, 404);
    if (task.scope === "system") return c.json({ error: "system tasks are read-only via chat (admin UI only)" }, 403);
    if (ctx2.role !== "admin" && task.creatorId !== ctx2.userId) return c.json({ error: "task not found" }, 404);
    const row = taskStore.setTaskEnabled(taskId, enabled, false);
    return c.json(row);
  });

  return app;
}

/** 启动 bridge。port=0 → 临时端口（测试用）；opts 注入 runRegistry/store/eventBus。返回实际端口 + stop()。 */
export function startBridge(port: number = BRIDGE_PORT, opts: BridgeDeps = {}): { port: number; stop: () => void } {
  const app = createBridgeApp(opts);
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
  const actual = server.port;
  if (actual === undefined) {
    server.stop();
    throw new Error("bridge: failed to acquire port");
  }
  return { port: actual, stop: () => server.stop() };
}
