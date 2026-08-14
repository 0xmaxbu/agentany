// ticket #18 审批门路由（main app，经 authStub → userIdOf）。**审批只人类**：
// pi 经 bridge 无法到此（bridge 无 /approvals 端点 + pi 沙箱禁 main app loopback）。
// POST /approvals/:id/decide：approve→CAS claim→createRun→回填 runId（引擎自发 run_started）；deny→CAS→不建 run。
import type { Hono } from "hono";
import type { RunDeps } from "../runs";
import { userIdOf, type AppEnv } from "../auth/middleware";
import { jsonBody } from "../http";

export function registerApprovalRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  app.post("/approvals/:id/decide", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const body = await jsonBody(c);
    const decision: string = body.decision;
    if (decision !== "approve" && decision !== "deny") return c.json({ error: "decision must be 'approve' or 'deny'" }, 400);

    const q = deps.store.getQuestion(id);
    if (!q || q.kind !== "approval") return c.json({ error: "approval not found" }, 404);
    const userId = userIdOf(c);

    if (decision === "deny") {
      const row = deps.store.markApprovalDecided(id, { decision: "deny" }, userId); // CAS 占位
      if (!row) return c.json({ error: "already decided" }, 409); // 已答（幂等）
      deps.eventBus?.publish(q.conversationId, { type: "hitl_answered", questionId: id, kind: "approval", answer: { decision: "deny" } });
      return c.json({ status: "denied" });
    }

    // approve：先查可用性（未占位）→ CAS 占位（防双击各起一个 run）→ start()；start 抛错/非 running → 回滚占位（可重试）→ 回填 runId。
    if (!deps.runRegistry) return c.json({ error: "run registry unavailable" }, 503);
    const claimed = deps.store.markApprovalDecided(id, { decision: "approve" }, userId);
    if (!claimed) return c.json({ error: "already decided" }, 409);
    let runId: string;
    try {
      const outcome = deps.runRegistry.start({
        conversationId: q.conversationId, workflowId: q.workflowId!, input: q.input ?? {}, approved: true,
      });
      if (outcome.status !== "running") {
        deps.store.reopenApproval(id); // 回滚（approved=true 下非 running 不该发生；防御）
        return c.json({ error: `unexpected start outcome: ${outcome.status}` }, 500);
      }
      runId = outcome.runId;
    } catch (e) {
      deps.store.reopenApproval(id); // 回滚 → 允许重试（会话被删 / 工作流失注等 start 抛错）
      return c.json({ error: `failed to start: ${(e as Error).message}` }, 500);
    }
    deps.store.backfillApprovalRunId(id, runId);
    deps.eventBus?.publish(q.conversationId, { type: "hitl_answered", questionId: id, kind: "approval", runId, answer: { decision: "approve" } });
    // 引擎 runDetached 自发 run_started（前端见 run 卡）；pi transcript 不反射（v1 已知 UX 缺口，#19+ 注入系统事件）。
    return c.json({ status: "approved", runId });
  });
}
