// 假飞书（spec #55/T1 测试接缝）：讲真飞书 HTTP 契约的 stub——token 交换 + 发消息端点。
// 与生产 transport 走同一 contract（client 的服务端镜像）；长连接侧（T2）在此之上扩展。
// fetchFn = (url, init) => app.request(pathname, init) —— transport 测/路由测共用。
import { Hono } from "hono";
import type { TransportFetch } from "../src/im/feishu/transport";

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

export function fakeFeishu(): { app: Hono; state: FakeFeishuState } {
  const state: FakeFeishuState = { tokenCalls: 0, sent: [] };
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

  return { app, state };
}

/** transport fetchFn 适配：Hono app 走 URL pathname + query（本仓测试惯例 app.request 直调，不真上网）。 */
export function fakeFeishuFetch(app: Hono): TransportFetch {
  return async (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    return app.request(url.pathname + url.search, init);
  };
}