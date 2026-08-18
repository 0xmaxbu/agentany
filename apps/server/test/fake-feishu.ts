// 假飞书（spec #55/T1+T2 测试接缝）：讲真飞书 HTTP 契约的 stub——token 交换 + 发消息端点 + 长连接 push。
// 与生产 transport/long-connection 走同一 contract（client 的服务端镜像）；长连接侧共享生产 pbbp2 codec
// （真 wire 字节：CI 测到帧格式本身，不 mock 协议）。
// fetchFn = (url, init) => app.request(pathname, init) —— transport 测/路由测共用。
// WS = 真 Bun WebSocket server（回环随机端口）——长连接测走真建连/真帧/真 ack。
import { Hono } from "hono";
import type { TransportFetch } from "../src/im/feishu/transport";
import {
  encodeFrame, decodeFrame, headerValue, toUint8Array,
  PBBP2_CONTROL, PBBP2_DATA,
  HDR_TYPE, HDR_MESSAGE_ID, HDR_SUM, HDR_SEQ, HDR_TRACE_ID, HDR_BIZ_RT,
  MSG_TYPE_EVENT, MSG_TYPE_PING,
} from "../src/im/feishu/pbbp2";

export interface FakeFeishuSent {
  auth: string;
  receiveId: string;
  msgType: string;
  content: unknown; // 已 parse（飞书消息体是 JSON 字符串）
  uuid: string | null;
}

export interface FakeFeishuState {
  tokenCalls: number;
  sent: FakeFeishuSent[];
  failSendWith?: { code: number; msg: string }; // 注入：让发消息端点失败（token 重试/上抛路径测）
}

const TE = new TextEncoder();

function makeRestApp(state: FakeFeishuState): Hono {
  const app = new Hono();

  app.post("/open-apis/auth/v3/tenant_access_token/internal", async (c) => {
    state.tokenCalls++;
    return c.json({ code: 0, msg: "ok", tenant_access_token: `t_fake_${state.tokenCalls}`, expire: 7200 });
  });

  app.post("/open-apis/im/v1/messages", async (c) => {
    if (state.failSendWith) return c.json(state.failSendWith);
    const b = (await c.req.json()) as { receive_id: string; msg_type: string; content: string };
    state.sent.push({
      auth: c.req.header("authorization") ?? "",
      receiveId: b.receive_id,
      msgType: b.msg_type,
      content: JSON.parse(b.content ?? "{}"),
      uuid: c.req.query("uuid") ?? null,
    });
    return c.json({ code: 0, msg: "ok" });
  });

  return app;
}

/** T1：纯 REST 假飞书（transport/出站路由共用）。 */
export function fakeFeishu(): { app: Hono; state: FakeFeishuState } {
  const state: FakeFeishuState = { tokenCalls: 0, sent: [] };
  return { app: makeRestApp(state), state };
}

export interface FakeFeishuWsAck {
  messageId: string;
  code: number; // -1 = payload 解析失败
  traceId: string | null;
  bizRt: string | null; // ack 带 biz_rt header（应立即存在）
  seqId: number;
  data?: unknown; // 卡回调 ack 的 data（base64 解码）：{toast, card}
}

export interface FakeFeishuWsState extends FakeFeishuState {
  events: number;          // 推送事件计数
  pings: number;           // 收到 client 心跳计数
  acks: FakeFeishuWsAck[]; // 收到 client data 帧 ack 记录
  wsClients: number;       // 当前连接数
}

export interface FakeFeishuWsPush {
  pushEvent: (payload: unknown, opts?: { messageId?: string; chunks?: number }) => Promise<{ ack: FakeFeishuWsAck }>;
  pushCardAction: (payload: unknown, opts?: { messageId?: string }) => Promise<{ ack: FakeFeishuWsAck }>;
}

/** T2：REST + 长连接假飞书。endpoint 握手返回真 WS URL（回环随机端口），可 pushEvent（分片可选）并断言 ack。 */
export function fakeFeishuWs(): { app: Hono; state: FakeFeishuWsState } & FakeFeishuWsPush & { close: () => void } {
  const state: FakeFeishuWsState = {
    tokenCalls: 0, sent: [], events: 0, pings: 0, acks: [], wsClients: 0,
  };
  const app = makeRestApp(state);

  // 真 WS server：先起（拿随机端口），endpoint 路由再引用 wsUrl。
  let wsUrl = "";
  const wsClients = new Set<unknown>();
  const pendingAcks = new Map<string, (a: FakeFeishuWsAck) => void>();
  let evtSeq = 0;

  const messageHandler = (msg: unknown): void => {
    const bytes = toUint8Array(msg);
    if (!bytes) return; // 协议为二进制
    let frame;
    try { frame = decodeFrame(bytes); } catch { return; }
    if (frame.method === PBBP2_CONTROL) {
      if (headerValue(frame.headers, HDR_TYPE) === MSG_TYPE_PING) state.pings++;
      return;
    }
    if (frame.method === PBBP2_DATA) {
      // client 的响应帧 = ack（data 字段 = 卡回调响应的 base64 JSON）
      const messageId = headerValue(frame.headers, HDR_MESSAGE_ID) ?? "";
      let code = -1;
      let data: unknown;
      try {
        const body = JSON.parse(new TextDecoder().decode(frame.payload)) as { code?: number; data?: string };
        code = body.code ?? -1;
        if (typeof body.data === "string") {
          try { data = JSON.parse(Buffer.from(body.data, "base64").toString("utf-8")); } catch { /* 非 JSON data 留 undefined */ }
        }
      } catch { /* 解析失败 code=-1 */ }
      const ack: FakeFeishuWsAck = {
        messageId,
        code,
        traceId: headerValue(frame.headers, HDR_TRACE_ID) ?? null,
        bizRt: headerValue(frame.headers, HDR_BIZ_RT) ?? null,
        seqId: frame.seqId,
        ...(data !== undefined ? { data } : {}),
      };
      state.acks.push(ack);
      const done = pendingAcks.get(messageId);
      if (done) { pendingAcks.delete(messageId); done(ack); }
    }
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return; // websocket 升级
      return new Response("ws only", { status: 404 });
    },
    websocket: {
      open(ws) { wsClients.add(ws); state.wsClients = wsClients.size; },
      message(ws, msg) { messageHandler(msg); },
      close(ws) { wsClients.delete(ws); state.wsClients = wsClients.size; },
    },
  });
  wsUrl = `ws://127.0.0.1:${server.port}/ws`;

  app.post("/callback/ws/endpoint", async (c) => {
    return c.json({
      code: 0, msg: "ok",
      data: { URL: wsUrl, ClientConfig: { ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0, PingInterval: 2 } },
    });
  });

  const pushFrame = (payload: unknown, frameType: "event" | "card", opts: { messageId?: string; chunks?: number } = {}): Promise<{ ack: FakeFeishuWsAck }> => {
    // live smoke 实测：真飞书把 card.action.trigger（卡片回调）走 EVENT 帧（header.event_type），不推 CARD 帧。
    // pushCardAction 应发 EVENT 帧（header.event_type=card.action.trigger），与真飞书同型——否则测不到真路径。
    if (frameType === "card") {
      const p = payload as { header?: { event_type?: string } };
      if (p?.header?.event_type === "card.action.trigger") frameType = "event";
    }
    const client = [...wsClients][0] as { send: (data: Uint8Array) => void };
    if (!client) return Promise.reject(new Error("no ws client connected"));
    const messageId = opts.messageId ?? `om_fake_${++evtSeq}`;
    const traceId = `tr_fake_${evtSeq}`;
    const json = TE.encode(JSON.stringify(payload));
    const chunks = opts.chunks ?? 1;
    const per = Math.ceil(json.length / chunks);
    for (let seq = 0; seq < chunks; seq++) {
      const slice = json.slice(seq * per, Math.min((seq + 1) * per, json.length));
      client.send(encodeFrame({
        seqId: 0, logId: 0, service: 0, method: PBBP2_DATA,
        headers: [
          { key: HDR_TYPE, value: frameType },
          { key: HDR_TRACE_ID, value: traceId },
          { key: HDR_MESSAGE_ID, value: messageId },
          { key: HDR_SUM, value: String(chunks) },
          { key: HDR_SEQ, value: String(seq) },
        ],
        payload: slice,
      }));
    }
    state.events++;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { pendingAcks.delete(messageId); reject(new Error("ack timeout (3s)")); }, 3000);
      pendingAcks.set(messageId, (ack) => { clearTimeout(to); resolve({ ack }); });
    });
  };
  const pushEvent = (payload: unknown, opts?: { messageId?: string; chunks?: number }) => pushFrame(payload, "event", opts);
  const pushCardAction = (payload: unknown, opts?: { messageId?: string }) => pushFrame(payload, "card", opts);

  return {
    app, state,
    pushEvent,
    pushCardAction,
    close() { try { server.stop(true); } catch { /* 已停 */ } },
  };
}

/** im.message.receive_v1 文本事件构造（p2p 单聊；可覆写字段测边界）。 */
export function receiveTextEvent(openId: string, text: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: "2.0",
    header: { event_id: `ev_fake_${++fevtSeq}`, event_type: "im.message.receive_v1", create_time: "1700000000000", app_id: "cli_x", tenant_key: "t_x" },
    event: {
      sender: { sender_id: { open_id: openId, union_id: "u", user_id: "u" }, sender_type: "user", tenant_key: "t_x" },
      message: {
        message_id: `om_fake_${fevtSeq}`, root_id: "", parent_id: "", create_time: "1700000000000",
        chat_id: "oc_x", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }), mentions: [],
      },
    },
    ...overrides,
  };
}
let fevtSeq = 0;

/** card.action.trigger 事件构造（按钮点击：operator=点击者，action.value=T3 嵌入的 {questionId,label}）。 */
export function cardActionEvent(openId: string, questionId: number, label: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: "2.0",
    header: { event_id: `ev_card_${++fevtSeq}`, event_type: "card.action.trigger", create_time: "1700000000000", app_id: "cli_x", tenant_key: "t_x" },
    event: {
      operator: { tenant_key: "t_x", open_id: openId, union_id: "u", user_id: "u" },
      action: { value: { questionId, value: label }, form: null, tag: "button" },
      context: { open_message_id: `om_card_${fevtSeq}`, open_chat_id: "oc_x", open_id: openId },
      token: "t",
    },
    ...overrides,
  };
}

/** transport fetchFn 适配：Hono app 走 URL pathname + query（本仓测试惯例 app.request 直调，不真上网）。 */
export function fakeFeishuFetch(app: Hono): TransportFetch {
  return async (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    return app.request(url.pathname + url.search, init);
  };
}