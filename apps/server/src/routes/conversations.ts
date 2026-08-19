// chat 切片② 路由（ADR-0009 / ticket #13，#48/T6 修订）：建会话 / 历史 / 持久流 / POST 消息(202 ACK) / abort。
// 事件驱动：POST /messages 不再返流，回 202 + 投 EventBus；前端经 GET /stream 长连订阅所有帧。
// #48/T6（ADR-0025 决策 9）：**user_message → HTTP turn 内联进 POST 路由**（不再绕经 EventBus 订阅一跳）——
// 谁消费输入谁起轮；run_* 事件不再驱动任何 turn（TurnTrigger 整类退役）；enqueueEventTurn 保留给定时任务。
// ADR-0018 鉴权：会话一律创建者私有（+admin）——canAccessConversation 全家守卫；建会话须 canAccessWorkspace。
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunDeps } from "../runs";
import { ConversationQueues } from "../chat/queue";
import { EventBus, type Frame } from "../chat/eventbus";
import { startUserTurn } from "../chat/turn-entry";
import { canAccessConversation, resolveRequestWorkspace } from "../workspaces/guard";
import { userIdOf, principalOf, userRoleOf, type AppEnv } from "../auth/middleware";
import { ROLE } from "../auth/store";
import { dbMessagesToHistory, readConversationHistory } from "../pi-session/reader";
import { alignDbIds } from "../chat/align-db-ids";
import { eraseConversationSessions } from "../pi-session/erase";
import { resolveScopePaths, scopeOf } from "../scope";
import { dispatchCardAnswer } from "../chat/hitl-dispatch";
import { jsonBody } from "../http";

const HEARTBEAT_MS = Number(process.env.CHAT_HEARTBEAT_MS ?? 15000);
const makeConversationId = (): string => "c_" + globalThis.crypto.randomUUID();

export function registerConversationRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  // FIFO 单实例：prod 由 index 注入共享（chat 与 #29 任务执行同实例——同会话严格串行）；测试缺省自建。
  const queues = deps.conversationQueues ?? new ConversationQueues();
  const eventBus = deps.eventBus ?? new EventBus(); // 共享单例（prod 由 index 注入；bridge run 事件经此到持久流）

  // 会话存在 + 当前用户可访问（创建者/admin）→ conv；否则 null（路由统一 404，不泄漏存在）。
  const loadIfVisible = (id: string, u: { id: string; role: "admin" | "member" }) => {
    const conv = deps.chatStore.getConversation(id);
    if (!conv || !canAccessConversation(conv, u)) return null;
    return conv;
  };

  app.post("/conversations", async (c) => {
    const body = await jsonBody(c);
    const title: string | undefined = body.title;
    if (body.projectId !== undefined) return c.json({ error: "projectId is gone; use workspaceId" }, 404); // 字段废止：显式拒绝，防旧客户端静默落错锚
    // 缺省 → 公司 ws；提供则格式（400）→ 存在性/权限（404）。统一走 resolveRequestWorkspace（与 workflows/runs 同口径）。
    const r = resolveRequestWorkspace(deps.workspaceStore, body.workspaceId, principalOf(c));
    if (!r.ok) return c.json({ error: r.error }, r.status);
    const workspaceId = r.workspaceId;
    const conv = deps.chatStore.createConversation({
      id: makeConversationId(),
      workspaceId,
      userId: userIdOf(c),
      title,
    });
    // #48/T6：无 TurnTrigger 订阅——user→turn 由 POST /messages 内联（谁消费输入谁起轮）
    return c.json(conv, 201);
  });

  app.get("/conversations/:id", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    return c.json(conv);
  });

  // 会话列表（#20/f2）：创建者私有，可选 workspaceId 过滤，updatedAt 倒序。#21：?archived=1 反向取归档。
  // #手风琴：limit/offset 分页（侧栏每组懒加载 10 条）；无参全量（搜索兜底）。offset 续页稳定性靠
  // updatedAt 倒序 + id 破并列（store 内 orderBy），同秒新建的会话翻页不会重/漏。
  app.get("/conversations", (c) => {
    const wsParam = c.req.query("workspaceId");
    const archived = c.req.query("archived") === "1";
    const limitRaw = Number(c.req.query("limit"));
    const offsetRaw = Number(c.req.query("offset"));
    const validNum = (n: number) => Number.isInteger(n) && n >= 0;
    const limit = validNum(limitRaw) ? limitRaw : undefined;
    const offset = validNum(offsetRaw) ? offsetRaw : undefined;
    return c.json(deps.chatStore.listConversations(userIdOf(c), wsParam || undefined, archived, limit, offset));
  });

  // 历史（#20 双源）：pi session 优先（blocks 结构真相源）；无 session 文件（e2e stub/首轮前）兜底 DB 冗余文本。
  app.get("/conversations/:id/messages", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const sessionDir = resolveScopePaths(scopeOf(conv.workspaceId), conv.workspaceId).sessionDir;
    const history = readConversationHistory(sessionDir, conv.id);
    if (history) {
      // #34 消息级反馈锚：pi 源 entry id ↔ DB messages.id 对齐回填（role+content 双指针贪心）
      return c.json(alignDbIds(history, deps.chatStore.listMessages(conv.id)));
    }
    return c.json(dbMessagesToHistory(deps.chatStore.listMessages(conv.id)));
  });

  // 产出文件列表（#30）：按 run 分组、outputMessageId 锚到产出消息尾（前端文件管理器式列表卡）。
  app.get("/conversations/:id/files", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    if (!deps.taskStore) return c.json({ error: "task store not wired" }, 500);
    return c.json(deps.taskStore.filesForConversation(conv.id));
  });

  // HITL 提问列表（ticket #16）：前端刷新恢复（pending 显卡 / answered 显答案）。
  app.get("/conversations/:id/hitl", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    return c.json(deps.hitlStore.listQuestions(conv.id, { includeAnswered: true }));
  });

  // run 卡刷新恢复（#53/T4）：域表直读该会话 run 列表（workflow_runs + workflow_run_log）。
  // 步骤收敛 = store listRunsWithSteps（log 一次批取，每步最新态 + 首现序）；route 只做 API 整形（去 input 等域列）。
  app.get("/conversations/:id/runs", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    return c.json({
      runs: deps.runStore.listRunsWithSteps(conv.id).map(({ runId, workflowId, status, brief, createdAt, updatedAt, steps }) => ({
        runId, workflowId, status, brief: brief ?? null, createdAt, updatedAt, steps,
      })),
    });
  });

  // 持久流（SSE，长连，承载所有帧）：订阅 EventBus 转发；心跳保活；客户端断开→取消订阅。
  app.get("/conversations/:id/stream", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const id = conv.id;
    return streamSSE(c, async (stream) => {
      // 所有写串一条 promise 链——防心跳注释插进 data 帧（Hono writeSSE/write 非原子）。
      let chain: Promise<unknown> = Promise.resolve();
      const writeRaw = (s: string) => {
        chain = chain.then(() => stream.write(s), () => {});
      };
      const send = (frame: Frame) => {
        chain = chain.then(() => stream.writeSSE({ data: JSON.stringify(frame) }), () => {});
      };
      const hb = setInterval(() => writeRaw(": ping\n\n"), HEARTBEAT_MS);
      const unsub = eventBus.subscribe(id, send);
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      // 幂等 close：客户端断开（onAbort）或 token 吊销（streamRegistry.abortUser）都走它——只断 SSE，不杀 run。
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsub();
        clearInterval(hb);
        release();
      };
      stream.onAbort(close);
      const detach = deps.streamRegistry.attach(userIdOf(c), close);
      await hold; // 长连直到客户端断开 / token 吊销强断
      detach();
      await chain; // flush 残留写
    });
  });

  // POST 消息 → 202 ACK + 投 EventBus。inReplyTo（可选 questionId）：统一卡应答——task/approval/ask 卡确定性收口
  // （零 LLM 二跳）；不带/不匹配 → 纯对话消息（LLM turn 老判答路不变）。
  // #48/T6（ADR-0025 决策 9/10）：**dispatch 前置判跳轮旗标 → 程序化轮（卡收口）不入队、免 429**；
  //   429 预检仅作用于将入队的 LLM 轮（满→429 不入队，消息未落）；user→turn **内联**（不再绕 EventBus 订阅一跳）。
  app.post("/conversations/:id/messages", async (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const id = conv.id;
    if (conv.archivedAt) return c.json({ error: "conversation archived (restore to continue)" }, 409); // #21：归档可看不可发（双保险——前端 composer 也禁用）
    const body = await jsonBody(c);
    const content: unknown = body.content;
    if (typeof content !== "string" || content.length === 0) return c.json({ error: "content required" }, 400);
    const inReplyTo: unknown = body.inReplyTo;
    const questionId = typeof inReplyTo === "number" && Number.isInteger(inReplyTo) ? inReplyTo : undefined;
    if (inReplyTo !== undefined && questionId === undefined) return c.json({ error: "inReplyTo must be an integer questionId" }, 400);
    // 前置 dispatch：卡应答的跳轮判定先于任何 429/入队（确定性收口路径永不因队列满被拒——净修复）。
    // slide（handled:false）不改状态 → 走 LLM 轮老路（429 预检照旧）。
    let skipTurn = false;
    if (questionId !== undefined) {
      const r = await dispatchCardAnswer(deps, id, questionId, content, userIdOf(c));
      if (r.error) console.warn(`[hitl-dispatch] question=${questionId}:`, r.error);
      skipTurn = !!r.skipTurn;
    }
    // ADR-0029：busy 预检内聚进 startUserTurn（user 写入前；skipTurn 程序化轮绕过永不 429）
    const res = startUserTurn({ deps, queues, publish: (f) => eventBus.publish(id, f) }, id, content, { skipTurn });
    if (res.status === "busy") return c.json({ error: "conversation busy (queue full)" }, 429);
    return c.json({ accepted: true }, 202);
  });

  app.post("/conversations/:id/abort", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const aborted = queues.abort(conv.id); // 杀当前在跑 turn（无论来源）
    const stopped = deps.runLifecycle?.stopConversationRuns(conv.id) ?? 0; // #19：停该会话所有 running run（kill pi + 置 failed）
    return c.json({ aborted, stopped });
  });

  // ── #21/ADR-0020：归档 / 恢复 / 删除 ──
  // 归档/恢复 = 创建者自己 + admin（loadIfVisible 天然达成：可见即创建者/admin）。
  // 先杀后删（决策 6）：复用 /abort 同机制（杀在跑 turn + 停 running runs）再落软态。
  app.patch("/conversations/:id/archive", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    queues.abort(conv.id);
    deps.runLifecycle?.stopConversationRuns(conv.id);
    const row = deps.chatStore.archiveConversation(conv.id);
    return row ? c.json(row) : c.json({ error: "conversation not found" }, 404);
  });

  app.patch("/conversations/:id/restore", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const row = deps.chatStore.restoreConversation(conv.id);
    return row ? c.json(row) : c.json({ error: "conversation not found" }, 404);
  });

  // 硬删 = admin-only（member 对自己会话也 403——不可逆操作收权）。全链清理：
  // DB 三表删 + runs 解绑（store 事务）+ pi session jsonl unlink + 内存态（abort/停 run）。
  app.delete("/conversations/:id", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    if (userRoleOf(c) !== ROLE.admin) return c.json({ error: "admin only" }, 403);
    queues.abort(conv.id); // 先杀后删：在跑 turn 杀 pi 子进程
    const stopped = deps.runLifecycle?.stopConversationRuns(conv.id) ?? 0; // running runs 停（suspended 无进程，仅解绑）
    const sessionDir = resolveScopePaths(scopeOf(conv.workspaceId), conv.workspaceId).sessionDir;
    const filesErased = eraseConversationSessions(sessionDir, conv.id);
    const ok = deps.chatStore.deleteConversation(conv.id);
    if (!ok) return c.json({ error: "conversation not found" }, 404);
    return c.json({ deleted: true, stopped, filesErased });
  });
}
