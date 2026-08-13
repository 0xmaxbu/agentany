// chat 切片② 路由（ADR-0009 / ticket #13）：建会话 / 历史 / 持久流 / POST 消息(202 ACK) / abort。
// 事件驱动：POST /messages 不再返流，回 202 + 投 EventBus；前端经 GET /stream 长连订阅所有帧。
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunDeps } from "../runs";
import { ConversationQueues } from "../chat/queue";
import { EventBus, type Frame } from "../chat/eventbus";
import { TurnTrigger } from "../chat/turn-trigger";
import { assertValidProjectId } from "../config";
import { userIdOf } from "./auth-stub";
import { jsonBody } from "../http";

const HEARTBEAT_MS = Number(process.env.CHAT_HEARTBEAT_MS ?? 15000);
const makeConversationId = (): string => "c_" + globalThis.crypto.randomUUID();


export function registerConversationRoutes(app: Hono, deps: RunDeps): void {
  // 单实例（per app = per 进程）：FIFO + 事件中心 + 调度入口。
  const queues = new ConversationQueues();
  const eventBus = deps.eventBus ?? new EventBus(); // 共享单例（prod 由 index 注入；bridge run 事件经此到持久流）
  const turnTrigger = new TurnTrigger({ deps, queues, eventBus });

  app.post("/conversations", async (c) => {
    const body = await jsonBody(c);
    const title: string | undefined = body.title;
    // 无 projectId → general（null，无项目会话）；提供则校验防路径注入（h1）。
    let projectId: string | null = null;
    const raw = body.projectId;
    if (typeof raw === "string" && raw.length > 0) {
      try {
        assertValidProjectId(raw);
        projectId = raw;
      } catch {
        return c.json({ error: "invalid projectId" }, 400);
      }
    }
    const conv = deps.store.createConversation({
      id: makeConversationId(),
      projectId,
      userId: userIdOf(c as any),
      title,
    });
    turnTrigger.attach(conv.id); // 会话建立即订阅 EventBus（user_message → 起 turn；#13 扇出到 TurnTrigger）
    return c.json(conv, 201);
  });

  app.get("/conversations/:id", (c) => {
    const conv = deps.store.getConversation(c.req.param("id"));
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    return c.json(conv);
  });

  app.get("/conversations/:id/messages", (c) => {
    const id = c.req.param("id");
    if (!deps.store.getConversation(id)) return c.json({ error: "conversation not found" }, 404);
    return c.json(deps.store.listMessages(id));
  });

  // HITL 提问列表（ticket #16）：前端刷新恢复（pending 显卡 / answered 显答案）。
  app.get("/conversations/:id/hitl", (c) => {
    const id = c.req.param("id");
    if (!deps.store.getConversation(id)) return c.json({ error: "conversation not found" }, 404);
    return c.json(deps.store.listQuestions(id, { includeAnswered: true }));
  });

  // 持久流（SSE，长连，承载所有帧）：订阅 EventBus 转发；心跳保活；客户端断开→取消订阅。
  app.get("/conversations/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!deps.store.getConversation(id)) return c.json({ error: "conversation not found" }, 404);
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
      stream.onAbort(() => {
        unsub();
        clearInterval(hb);
        release();
      });
      await hold; // 长连直到客户端断开
      await chain; // flush 残留写
    });
  });

  // POST 消息 → 202 ACK + 投 EventBus（不再返流）。429 由 TurnTrigger 同步判（满即不入队）。
  app.post("/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!deps.store.getConversation(id)) return c.json({ error: "conversation not found" }, 404);
    const body = await jsonBody(c);
    const content: unknown = body.content;
    if (typeof content !== "string" || content.length === 0) return c.json({ error: "content required" }, 400);
    if (!queues.wouldAcceptHttpTurn(id)) return c.json({ error: "conversation busy (queue full)" }, 429); // 同步 429 预检（不入队）
    const userMsgId = deps.store.appendMessage({ conversationId: id, role: "user", content }); // 立即落库
    eventBus.publish(id, { type: "user_message", id: userMsgId, content }); // 扇出：持久流显示用户消息 + TurnTrigger 起 turn
    return c.json({ accepted: true }, 202);
  });

  app.post("/conversations/:id/abort", (c) => {
    const id = c.req.param("id");
    if (!deps.store.getConversation(id)) return c.json({ error: "conversation not found" }, 404);
    const aborted = queues.abort(id); // 杀当前在跑 turn（无论来源）
    const stopped = deps.runRegistry?.stopConversationRuns(id) ?? 0; // #19：停该会话所有 running run（kill pi + 置 failed）
    return c.json({ aborted, stopped });
  });
}
