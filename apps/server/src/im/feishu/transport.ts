// 飞书出站 transport（spec #55/T1）：只有 REST 短连（发消息），前置 tenant_access_token 获取 + 过期缓存。
// 入站长连接（raw protobuf）是 T2——本文件不碰 WS。baseUrl/fetchFn 可注入：测试指向假飞书（test/fake-feishu.ts），
// 生产缺省 open.feishu.cn + 全局 fetch。凭证 env（FEISHU_APP_ID/FEISHU_APP_SECRET），index 装配时缺一不接线。
// ADR-0032：FeishuPlatformAdapter 的发送内部件（REST 半边）；失败重试/包装由 adapter.sendText/sendCard 承担。
import type { ImSendOptions } from "../types";

/** FeishuTransport 的发送载荷（text/cardJson 互斥；卡片优先）。 */
export interface FeishuOutboundMessage {
  text?: string;
  cardJson?: unknown;
}

const TOKEN_BUFFER_MS = 60_000; // 过期前 60s 预刷新（飞书 expire 单位秒；网络抖动缓冲）

/** 宽松 fetch 签名（Bun 的 typeof fetch 带 preconnect 静态成员，`typeof fetch` 参数对 stub 适配器过严）。 */
export type TransportFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FeishuTransportOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;           // 缺省 open.feishu.cn（真实）；测试传假飞书
  fetchFn?: TransportFetch;   // 缺省全局 fetch；测试传 Hono app.request 适配
  log?: (m: string) => void;
}

export class FeishuTransport {
  readonly platform = "feishu";
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private opts: FeishuTransportOptions) {
    if (!opts.appId || !opts.appSecret) throw new Error("FeishuTransport: appId/appSecret required");
  }

  private async req(pathWithQuery: string, init: RequestInit): Promise<Response> {
    const base = this.opts.baseUrl ?? "https://open.feishu.cn";
    const fetchFn = this.opts.fetchFn ?? fetch;
    return fetchFn(`${base}${pathWithQuery}`, init);
  }

  private async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached && Date.now() < cached.expiresAt - TOKEN_BUFFER_MS) return cached.value;
    const r = await this.req("/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
    });
    const j = (await r.json()) as { code: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!r.ok || j.code !== 0 || !j.tenant_access_token) {
      throw new Error(`feishu tenant token failed: ${j.code} ${j.msg ?? r.status}`);
    }
    this.token = { value: j.tenant_access_token, expiresAt: Date.now() + (j.expire ?? 7200) * 1000 };
    return this.token.value;
  }

  async send(target: string, msg: FeishuOutboundMessage, opts?: ImSendOptions): Promise<void> {
    const token = await this.accessToken();
    // 卡片优先；否则纯文本。content 是 JSON 字符串（飞书契约：消息体统一序列化）。
    const msgType = msg.cardJson ? "interactive" : "text";
    const content = JSON.stringify(msg.cardJson ?? { text: msg.text });
    const qs = `receive_id_type=open_id${opts?.uuid ? `&uuid=${encodeURIComponent(opts.uuid)}` : ""}`;
    const r = await this.req(`/open-apis/im/v1/messages?${qs}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ receive_id: target, msg_type: msgType, content }),
    });
    const j = (await r.json()) as { code: number; msg?: string };
    if (!r.ok || j.code !== 0) {
      // token 到期被拒时清缓存重试一次（预刷新缓冲兜不住的网络/时钟偏差）；仍失败则上抛（调用方记 warn）
      if (r.status === 401 || j.code === 99991663) {
        this.token = null;
        if (!this.retried) { this.retried = true; return this.doRetry(target, msg, opts); }
      }
      throw new Error(`feishu send failed: ${j.code} ${j.msg ?? r.status}`);
    }
  }

  private retried = false;
  private async doRetry(target: string, msg: FeishuOutboundMessage, opts?: ImSendOptions): Promise<void> {
    try { await this.send(target, msg, opts); }
    finally { this.retried = false; }
  }
}