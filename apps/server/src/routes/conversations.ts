// chat 切片② 路由（ADR-0009 / ticket #13）：建会话 / 历史 / 持久流 / POST 消息(202 ACK) / abort。
// 事件驱动：POST /messages 不再返流，回 202 + 投 EventBus；前端经 GET /stream 长连订阅所有帧。
// ADR-0018 鉴权：会话一律创建者私有（+admin）——canAccessConversation 全家守卫；建会话须 canAccessWorkspace。
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunDeps } from "../runs";
import { ConversationQueues } from "../chat/queue";
import { EventBus, type Frame } from "../chat/eventbus";
import { TurnTrigger } from "../chat/turn-trigger";
import { canAccessConversation, resolveRequestWorkspace } from "../workspaces/guard";
import { userIdOf, principalOf, type AppEnv } from "../auth/middleware";
import { dbMessagesToHistory, readConversationHistory } from "../pi-session/reader";
import { resolveScopePaths, scopeOf } from "../scope";
import { jsonBody } from "../http";

const HEARTBEAT_MS = Number(process.env.CHAT_HEARTBEAT_MS ?? 15000);
const makeConversationId = (): string => "c_" + globalThis.crypto.randomUUID();

export function registerConversationRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  // 单实例（per app = per 进程）：FIFO + 事件中心 + 调度入口。
  const queues = new ConversationQueues();
  const eventBus = deps.eventBus ?? new EventBus(); // 共享单例（prod 由 index 注入；bridge run 事件经此到持久流）
  const turnTrigger = new TurnTrigger({ deps, queues, eventBus });

  // 会话存在 + 当前用户可访问（创建者/admin）→ conv；否则 null（路由统一 404，不泄漏存在）。
  const loadIfVisible = (id: string, u: { id: string; role: "admin" | "member" }) => {
    const conv = deps.store.getConversation(id);
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
    const conv = deps.store.createConversation({
      id: makeConversationId(),
      workspaceId,
      userId: userIdOf(c),
      title,
    });
    turnTrigger.attach(conv.id); // 会话建立即订阅 EventBus（user_message → 起 turn；#13 扇出到 TurnTrigger）
    return c.json(conv, 201);
  });

  app.get("/conversations/:id", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    return c.json(conv);
  });

  // 会话列表（#20/f2）：创建者私有，可选 workspaceId 过滤，updatedAt 倒序。
  app.get("/conversations", (c) => {
    const wsParam = c.req.query("workspaceId");
    return c.json(deps.store.listConversations(userIdOf(c), wsParam || undefined));
  });

  // 历史（#20 双源）：pi session 优先（blocks 结构真相源）；无 session 文件（e2e stub/首轮前）兜底 DB 冗余文本。
  app.get("/conversations/:id/messages", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const sessionDir = resolveScopePaths(scopeOf(conv.workspaceId), conv.workspaceId).sessionDir;
    const history = readConversationHistory(sessionDir, conv.id);
    if (history) return c.json(history);
    return c.json(dbMessagesToHistory(deps.store.listMessages(conv.id)));
  });

  // HITL 提问列表（ticket #16）：前端刷新恢复（pending 显卡 / answered 显答案）。
  app.get("/conversations/:id/hitl", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    return c.json(deps.store.listQuestions(conv.id, { includeAnswered: true }));
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

  // POST 消息 → 202 ACK + 投 EventBus（不再返流）。429 由 TurnTrigger 同步判（满即不入队）。
  app.post("/conversations/:id/messages", async (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const id = conv.id;
    const body = await jsonBody(c);
    const content: unknown = body.content;
    if (typeof content !== "string" || content.length === 0) return c.json({ error: "content required" }, 400);
    if (!queues.wouldAcceptHttpTurn(id)) return c.json({ error: "conversation busy (queue full)" }, 429); // 同步 429 预检（不入队）
    const userMsgId = deps.store.appendMessage({ conversationId: id, role: "user", content }); // 立即落库
    deps.store.touchConversation(id); // updatedAt = 列表排序锚（#20）
    turnTrigger.attach(id); // 幂等兜底：后端重启后旧会话的 attached 内存态丢失——不补则 user_message 无人响应（turn 永不起）
    eventBus.publish(id, { type: "user_message", id: userMsgId, content }); // 扇出：持久流显示用户消息 + TurnTrigger 起 turn
    return c.json({ accepted: true }, 202);
  });

  app.post("/conversations/:id/abort", (c) => {
    const conv = loadIfVisible(c.req.param("id"), principalOf(c));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    const aborted = queues.abort(conv.id); // 杀当前在跑 turn（无论来源）
    const stopped = deps.runRegistry?.stopConversationRuns(conv.id) ?? 0; // #19：停该会话所有 running run（kill pi + 置 failed）
    return c.json({ aborted, stopped });
  });
}
