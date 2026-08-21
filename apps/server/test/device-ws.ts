// 假设备 WS 客户端 helper（ADR-0033 / R-2 交付；R-3/4/5 复用）。
// 封装 Bun WebSocket client：connect(token, deviceId) → 建连（带 Authorization + X-Device-Id）；
// on(type, fn) 收集消息；send(obj) 发 JSON；waitClose 等 close(code/reason)。
// token 无效时服务器不升级：connect 走 query 参数则 fetch 401、Bun 报 connect error——用 upgradeError 区分。
import type { ServerWebSocket } from "bun";

export interface DeviceCloseInfo {
  code: number;
  reason: string;
}

export class FakeDevice {
  ws: WebSocket | ServerWebSocket<unknown>;
  private incoming: unknown[] = []; // 全量收件（断言/检查用）
  private queue: unknown[] = []; // 未消费消息（waitForMessage 按 type 消费一支队）
  private waiters: Array<{ type: string; resolve: (m: unknown) => void }> = [];
  private closeP: Promise<DeviceCloseInfo>;
  private resolveClose!: (i: DeviceCloseInfo) => void;
  private closeResolved = false;

  constructor(ws: WebSocket | ServerWebSocket<unknown>) {
    this.ws = ws;
    this.closeP = new Promise<DeviceCloseInfo>((r) => (this.resolveClose = r));
    if (ws instanceof WebSocket) {
      (ws as WebSocket).onmessage = (ev) => this.push(ev.data);
      (ws as WebSocket).onclose = (ev) => this.settle(ev.code, ev.reason);
    }
  }

  static connect(
    wsBase: string,
    opts: { token: string; deviceId: string },
  ): Promise<FakeDevice> {
    return new Promise<FakeDevice>((resolve, reject) => {
      const ws = new WebSocket(wsBase, { headers: { Authorization: `Bearer ${opts.token}`, "X-Device-Id": opts.deviceId } });
      const dev = new FakeDevice(ws);
      ws.onopen = () => resolve(dev);
      ws.onerror = () => reject(new Error("device ws connect error (likely upgrade rejected)"));
    });
  }

  /** 服务器推送的 JSON 消息。 */
  messages(): unknown[] {
    return this.incoming;
  }

  /** 等一条 type 匹配的消息（服务端主动推送；consume-once——匹配即从队首消费，历史帧不回放）。 */
  waitForMessage(type: string, timeoutMs = 2000): Promise<unknown> {
    const hit = this.queue.find((m) => (m as any)?.type === type);
    if (hit) {
      this.queue.splice(this.queue.indexOf(hit), 1);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting device message type=${type}`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  /** 清空收件/待消费队列（断言「不应再有帧」前用）。 */
  clear(): void {
    this.incoming.length = 0;
    this.queue.length = 0;
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 已关 */
    }
  }

  waitClose(timeoutMs = 2000): Promise<DeviceCloseInfo> {
    const t = setTimeout(() => this.settle(-1, "timeout"), timeoutMs);
    return this.closeP.finally(() => clearTimeout(t));
  }

  private push(raw: unknown): void {
    let msg: unknown = raw;
    if (typeof raw === "string") {
      try {
        msg = JSON.parse(raw);
      } catch {
        msg = raw; // 非 JSON（如 pong 控制帧文本）原样入队
      }
    }
    this.incoming.push(msg);
    const i = this.waiters.findIndex((w) => w.type === (msg as any)?.type);
    if (i >= 0) {
      this.waiters.splice(i, 1)[0].resolve(msg);
    } else {
      this.queue.push(msg); // 无 waitFor 等它 → 入队供后续 consume
    }
  }

  private settle(code: number, reason: string): void {
    if (this.closeResolved) return;
    this.closeResolved = true;
    this.resolveClose({ code, reason });
  }
}