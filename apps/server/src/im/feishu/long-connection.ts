// 飞书长连接 client（spec #55/T2 #57）：免公网入站事件。官方 SDK 有 Bun 长连接静默丢事件问题
// （larksuite/node-sdk #201），故按 open 协议手搓（与官方 python/go ws 模块同契约，见 pbbp2.ts）。
//
// 流程（对照官方 lark_oapi/ws/client.py）：
//   1. POST {baseUrl}/callback/ws/endpoint {AppID, AppSecret} → {URL, ClientConfig}（含 PingInterval/重连参数）
//   2. new WebSocket(URL) 建连（帧是二进制 protobuf，非 JSON）
//   3. 周期发 control 帧 type=ping（官方：client 主动心跳）+ 响应帧 ack
//   4. method=1 data 帧：合包(sum>1 按 message_id+seq 组装) → type=event → 立即 ack（复用原帧身份 + biz_rt）
//      → 异步 onEvent（判答不阻塞 ack；server 3s 无 ack 会重推）
//   5. 断线 → 有界退避重连（reconnectNonce 抖动 + reconnectInterval 间隔；reconnectCount<0 无限重连）
import type { TransportFetch } from "./transport";
import {
  encodeFrame, decodeFrame, headerValue, toUint8Array,
  PBBP2_CONTROL, PBBP2_DATA,
  HDR_TYPE, HDR_MESSAGE_ID, HDR_SUM, HDR_SEQ, HDR_TRACE_ID, HDR_BIZ_RT,
  MSG_TYPE_EVENT, MSG_TYPE_PING, MSG_TYPE_PONG,
  type Pbbp2Frame,
} from "./pbbp2";

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const ENDPOINT_PATH = "/callback/ws/endpoint";
const CONNECT_TIMEOUT_MS = 10_000; // 建连看护：超时判失败（进重连）
const ACK_OK = '{"code":200}'; // ack 载荷（响应帧业务码）

export interface ReconnectConfig {
  reconnectCount: number;      // -1 = 无限重连；≥0 = 最多重试次数
  reconnectIntervalMs: number; // 重试间隔
  reconnectNonceMs: number;    // 首次退避随机抖动上限
}

/** 有界退避：第 attempt 次失败后的等待时长（纯函数，测试直测）。 */
export function backoffDelayMs(attempt: number, cfg: ReconnectConfig, rand: () => number = Math.random): number {
  const jitter = cfg.reconnectNonceMs > 0 ? rand() * cfg.reconnectNonceMs : 0;
  return jitter + cfg.reconnectIntervalMs;
}

/** 是否放弃重连（count<0 → 永不放弃；否则超过 count 次失败即止）。 */
export function shouldGiveUp(attempt: number, cfg: ReconnectConfig): boolean {
  return cfg.reconnectCount >= 0 && attempt > cfg.reconnectCount;
}

interface ClientConfig {
  ReconnectCount?: number;
  ReconnectInterval?: number; // 秒
  ReconnectNonce?: number;    // 秒
  PingInterval?: number;      // 秒
}

export interface FeishuLongConnectionOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;          // 缺省 open.feishu.cn；测试传假飞书
  endpointPath?: string;     // 测试可换地址
  fetchFn?: TransportFetch;  // 握手 HTTP 注入（测试指假飞书）
  onEvent?: (payload: unknown) => void; // 事件 JSON（type=event 已过滤、已 ack）
  log?: (m: string) => void;
  pingIntervalMs?: number;         // 显式覆盖（缺省用 endpoint 的 PingInterval*1000）
  reconnectCount?: number;         // 显式覆盖（缺省 endpoint；再缺省 -1 无限）
  reconnectIntervalMs?: number;
  reconnectNonceMs?: number;
}

export type LongConnectionStatus = "stopped" | "connecting" | "reconnecting" | "connected";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FeishuLongConnection {
  readonly platform = "feishu" as const;
  private opts: FeishuLongConnectionOptions;
  private ws?: WebSocket;
  private status: LongConnectionStatus = "stopped";
  private stopped = true;
  private loopActive = false;
  private pingTimer?: ReturnType<typeof setInterval>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private currentService = 0; // ws URL 的 service_id（心跳帧 service 字段；absence 则 0）
  private cfg: ReconnectConfig = { reconnectCount: -1, reconnectIntervalMs: 120_000, reconnectNonceMs: 30_000 };
  private pingIntervalMs = 120_000;
  private chunkRecs = new Map<string, { total: number; buf: (Uint8Array | null)[]; last: Pbbp2Frame }>();

  constructor(opts: FeishuLongConnectionOptions) {
    if (!opts.appId || !opts.appSecret) throw new Error("FeishuLongConnection: appId/appSecret required");
    this.opts = opts;
  }

  get statusNow(): LongConnectionStatus { return this.status; }

  start(): void {
    if (!this.stopped) return; // 已在跑
    this.stopped = false;
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pingTimer); this.pingTimer = undefined;
    clearTimeout(this.connectTimer); this.connectTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws) { try { ws.close(1000, "client stop"); } catch { /* 已关 */ } }
    this.setStatus("stopped");
  }

  private log(m: string): void { this.opts.log?.(m); }

  private setStatus(s: LongConnectionStatus): void {
    if (this.status !== s) this.status = s;
  }

  // ── 连接循环（初始建连 + 断线重连共用；loopActive 防重入）──
  private async connectLoop(): Promise<void> {
    if (this.loopActive) return;
    this.loopActive = true;
    try {
      let fails = 0;
      while (!this.stopped) {
        try {
          await this.connectOnce();
          fails = 0;
          return; // 连上即停
        } catch (e) {
          if (this.stopped) return;
          fails++;
          if (shouldGiveUp(fails, this.cfg)) {
            this.log(`[im] 长连接重试耗尽（${this.cfg.reconnectCount} 次），停止`);
            this.setStatus("reconnecting");
            return;
          }
          const ms = backoffDelayMs(fails, this.cfg);
          this.setStatus("reconnecting");
          this.log(`[im] 长连接失败(${fails})，${Math.round(ms)}ms 后重试：${e instanceof Error ? e.message : String(e)}`);
          await sleep(ms);
        }
      }
    } finally {
      this.loopActive = false;
    }
  }

  private async connectOnce(): Promise<void> {
    const { URL: wsUrl, ClientConfig } = await this.discoverEndpoint();
    this.applyClientConfig(ClientConfig);
    this.setStatus("connecting");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(this.connectTimer); fn(); };
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        finish(() => reject(e));
        return;
      }
      ws.binaryType = "arraybuffer";
      this.currentService = Number(new URL(wsUrl).searchParams.get("service_id")) || 0;
      ws.onopen = () => {
        finish(() => {
          this.ws = ws;
          this.setStatus("connected");
          this.startPing();
          resolve();
        });
      };
      ws.onerror = () => { if (this.ws === ws) this.log("[im] ws 错误（将走 onclose 重连）"); };
      ws.onclose = () => {
        if (!settled) { finish(() => reject(new Error("ws closed before open"))); return; }
        if (this.ws === ws) {
          this.ws = undefined;
          clearInterval(this.pingTimer); this.pingTimer = undefined;
          if (!this.stopped) void this.connectLoop();
        }
      };
      ws.onmessage = (ev) => this.receive(ev.data);
      // 建连看护：10s 未 open → 判失败
      this.connectTimer = setTimeout(() => {
        finish(() => { try { ws.close(); } catch { /* 已关 */ } reject(new Error("ws connect timeout")); });
      }, CONNECT_TIMEOUT_MS);
    });
  }

  private async discoverEndpoint(): Promise<{ URL: string; ClientConfig?: ClientConfig }> {
    const url = `${this.opts.baseUrl ?? DEFAULT_BASE_URL}${this.opts.endpointPath ?? ENDPOINT_PATH}`;
    const fetchFn = this.opts.fetchFn ?? fetch;
    const r = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ AppID: this.opts.appId, AppSecret: this.opts.appSecret }),
    });
    const j = (await r.json()) as { code: number; msg?: string; data?: { URL?: string; ClientConfig?: ClientConfig } };
    if (!r.ok || j.code !== 0 || !j.data?.URL) {
      throw new Error(`feishu ws endpoint failed: ${j.code} ${j.msg ?? r.status}`);
    }
    return { URL: j.data.URL, ClientConfig: j.data.ClientConfig };
  }

  private applyClientConfig(c?: ClientConfig): void {
    // 优先级：显式 opts > endpoint 权威下发（每次握手全量刷新）> 构造默认（类字段初始值）。
    if (this.opts.pingIntervalMs !== undefined) this.pingIntervalMs = this.opts.pingIntervalMs;
    else if (c?.PingInterval !== undefined) this.pingIntervalMs = c.PingInterval * 1000;
    if (this.opts.reconnectCount !== undefined) this.cfg.reconnectCount = this.opts.reconnectCount;
    else if (c?.ReconnectCount !== undefined) this.cfg.reconnectCount = c.ReconnectCount;
    if (this.opts.reconnectIntervalMs !== undefined) this.cfg.reconnectIntervalMs = this.opts.reconnectIntervalMs;
    else if (c?.ReconnectInterval !== undefined) this.cfg.reconnectIntervalMs = c.ReconnectInterval * 1000;
    if (this.opts.reconnectNonceMs !== undefined) this.cfg.reconnectNonceMs = this.opts.reconnectNonceMs;
    else if (c?.ReconnectNonce !== undefined) this.cfg.reconnectNonceMs = c.ReconnectNonce * 1000;
  }

  private startPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(encodeFrame({
          seqId: 0, logId: 0, service: this.currentService, method: PBBP2_CONTROL,
          headers: [{ key: HDR_TYPE, value: MSG_TYPE_PING }], payload: new Uint8Array(),
        }));
      } catch (e) { this.log(`[im] ping 发送失败：${e instanceof Error ? e.message : String(e)}`); }
    }, this.pingIntervalMs);
  }

  // ── 帧接收 ──
  private receive(raw: unknown): void {
    const bytes = toUint8Array(raw);
    if (!bytes) { this.log("[im] 收到文本帧（协议为二进制），丢弃"); return; }
    let frame: Pbbp2Frame;
    try { frame = decodeFrame(bytes); } catch (e) { this.log(`[im] 帧解码失败: ${e instanceof Error ? e.message : String(e)}`); return; }
    if (frame.method === PBBP2_CONTROL) this.handleControl(frame);
    else if (frame.method === PBBP2_DATA) this.handleData(frame);
  }

  private handleControl(frame: Pbbp2Frame): void {
    const t = headerValue(frame.headers, HDR_TYPE);
    if (t === MSG_TYPE_PING) return; // 官方 python 同样忽略入向 ping
    if (t === MSG_TYPE_PONG) { this.log("[im] pong"); return; } // 心跳健康确认（payload 可含新 ClientConfig，暂不理）
  }

  private handleData(frame: Pbbp2Frame): void {
    const type = headerValue(frame.headers, HDR_TYPE);
    if (type !== MSG_TYPE_EVENT) return; // card 等留待 T4
    const msStart = Date.now();
    const messageId = headerValue(frame.headers, HDR_MESSAGE_ID) ?? "";
    const sum = Number(headerValue(frame.headers, HDR_SUM) ?? "1") || 1;
    const seq = Number(headerValue(frame.headers, HDR_SEQ) ?? "0") || 0;

    let payload = frame.payload;
    let ackIdent: Pbbp2Frame = frame;
    if (sum > 1) {
      const combined = this.assembleChunks(messageId, sum, seq, frame);
      if (combined === null) return; // 分片未齐，等后续帧
      payload = combined.payload;
      ackIdent = combined.last; // 合包 ack 用收到最后一帧的身份
    }

    // 事件立即 ack（3s 限时在服务端；本地即刻回，判答异步不阻塞 ack）
    this.sendAck(ackIdent, msStart);

    try {
      const evt = JSON.parse(new TextDecoder().decode(payload)) as unknown;
      if (this.opts.onEvent) this.opts.onEvent(evt);
    } catch (e) {
      this.log(`[im] 事件解析/分发失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 合包：全分片齐 → 拼接并返回 { payload, last }（ack 身份 = 最后一帧）；未齐 → null。 */
  private assembleChunks(messageId: string, sum: number, seq: number, frame: Pbbp2Frame): { payload: Uint8Array; last: Pbbp2Frame } | null {
    let rec = this.chunkRecs.get(messageId);
    if (!rec) { rec = { total: sum, buf: new Array<Uint8Array | null>(sum).fill(null), last: frame }; this.chunkRecs.set(messageId, rec); }
    rec.last = frame;
    rec.buf[seq] = frame.payload;
    if (rec.buf.some((b) => b === null)) return null;
    this.chunkRecs.delete(messageId);
    const len = rec.buf.reduce((n, b) => n + b!.length, 0);
    const all = new Uint8Array(len);
    let o = 0;
    for (const b of rec.buf) { all.set(b!, o); o += b!.length; }
    return { payload: all, last: rec.last };
  }

  private sendAck(ident: Pbbp2Frame, msStart: number): void {
    const headers = [...ident.headers, { key: HDR_BIZ_RT, value: String(Date.now() - msStart) }];
    try {
      // 响应帧 = 原帧身份（seqId/logId/service/method/headers 原样）+ payload 换成 ack JSON（官方同款）
      this.ws!.send(encodeFrame({
        seqId: ident.seqId, logId: ident.logId, service: ident.service, method: ident.method,
        headers, payload: new TextEncoder().encode(ACK_OK),
      }));
    } catch (e) {
      this.log(`[im] ack 发送失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}