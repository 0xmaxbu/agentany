// bridge：pi 子进程 → 服务端的薄 RPC 通道（#11 骨架 / #14 /run/* / #16 HITL /ask_user + /run/resume）。
// 独立 Hono on loopback:BRIDGE_PORT（默认 3199），全局 per-turn nonce 中间件（Authorization: Bearer）。
// 端点：/ping、/run/start、/run/read、/ask_user（建 pending 提问）、/run/resume（续跑 + 标 answered）。
// 仅绑 127.0.0.1 + nonce 闸：只有本机持有效 nonce 的 pi 子进程能调。
import { Hono } from "hono";
import { verifyNonce, nonceConversation } from "./nonce";
import type { RunRegistry } from "../runs/registry";
import type { WorkflowStore } from "../workflow-engine/store";
import type { EventBus, Frame } from "../chat/eventbus";
import type { ResumeOutcome } from "../workflow-engine/runner";
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
  runRegistry?: RunRegistry;
  store?: WorkflowStore;
  eventBus?: EventBus;
}

export function createBridgeApp(opts: BridgeDeps = {}): Hono {
  const app = new Hono();
  const { runRegistry: reg, store, eventBus } = opts;

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
      return c.json(reg.start({ conversationId, workflowId, input: input ?? {} }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // /run/read：read_run 工具经此。跨会话 guard（同 /ask_user /run/resume）：nonce 仅授权本会话，不得读他 conv 的 run。
  app.get("/run/read", (c) => {
    if (!reg || !store) return c.json({ error: "run registry unavailable" }, 503);
    const convId = nonceConversation(bearerToken(c.req.header("authorization"))!);
    if (!convId) return c.json({ error: "no conversation for nonce" }, 400);
    const runId = c.req.query("runId");
    if (!runId) return c.json({ error: "runId required" }, 400);
    const run = store.getRun(runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (run.conversationId !== convId) return c.json({ error: "forbidden" }, 403); // 跨会话 guard
    const r = reg.read(runId);
    if (!r) return c.json({ error: "run not found" }, 404);
    return c.json(r);
  });

  // /ask_user（#16）：ask_user 工具经此。建 pending 提问（落 DB + 推 hitl_request）→ 立即返 {asked}（不阻塞 turn）。
  app.post("/ask_user", async (c) => {
    if (!store || !eventBus) return c.json({ error: "hitl unavailable" }, 503);
    const convId = nonceConversation(bearerToken(c.req.header("authorization"))!);
    if (!convId) return c.json({ error: "no conversation for nonce" }, 400);
    const body = await jsonBody(c);
    const { runId, prompt, options, resumeSchema, multiple } = body as { runId?: string; prompt?: string; options?: string[]; resumeSchema?: unknown; multiple?: boolean };
    if (!runId || typeof prompt !== "string" || !Array.isArray(options)) return c.json({ error: "runId, prompt, options required" }, 400);
    const run = store.getRun(runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (run.conversationId !== convId) return c.json({ error: "forbidden" }, 403); // 跨会话 guard
    if (run.status !== "suspended") return c.json({ error: "run not suspended" }, 409);
    const existing = store.getPendingByRun(runId);
    if (existing) return c.json({ status: "already_asked", questionId: existing.id }); // 幂等：同 run 已有 pending
    const rs = resumeSchema ?? store.getLog(runId).at(-1)?.resumeSchema; // 自动取（手搓可序列化 schema，pi/前端可读）
    const id = store.createQuestion({ conversationId: convId, runId, prompt, options, resumeSchema: rs, multiple });
    const frame: Frame = { type: "hitl_request", questionId: id, runId, prompt, options, resumeSchema: rs, multiple: multiple ? 1 : 0 };
    eventBus.publish(convId, frame);
    return c.json({ status: "asked", questionId: id });
  });

  // /run/resume（#16）：resume_workflow 工具经此。registry.resume 三态分支；clean→markAnswered + 推 hitl_answered。
  app.post("/run/resume", async (c) => {
    if (!reg) return c.json({ error: "run registry unavailable" }, 503);
    const convId = nonceConversation(bearerToken(c.req.header("authorization"))!);
    if (!convId) return c.json({ error: "no conversation for nonce" }, 400);
    const body = await jsonBody(c);
    const { runId, resumeData } = body as { runId?: string; resumeData?: unknown };
    if (!runId) return c.json({ error: "runId required" }, 400);
    const run = store?.getRun(runId);
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
    // clean（completed/suspended/failed）→ 标该 run 的 pending 提问 answered + 推 hitl_answered
    const row = store?.markPendingAnsweredByRun(runId, resumeData);
    if (row && eventBus) eventBus.publish(convId, { type: "hitl_answered", questionId: row.id, answer: resumeData });
    return c.json({ status: outcome.status });
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
