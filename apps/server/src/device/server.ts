// 设备 WebSocket 入口 + 单 seam 助手（ADR-0033 / R-2 交付）：`serve(app, opts)` 把 HTTP + WS 一起起活。
// - HTTP 全走 app.fetch；WS `/ws/device` 在 upgrade 前验 token（Bearer + X-Device-Id），未过不升级（401）。
// - 真鉴权路径：**设备路径默认不走 dev 逃生阀**——validation 直调 userStore.resolveToken（AGENTANY_DEV_TOKEN 不覆盖）。
// - open 登记 registry（触发单机顶号，见 DeviceRegistry.register）；close 反注册 + remote_clients 置离线。
// - 心跳：应用层 `{type:"ping"}` → `{type:"pong"}`；空闲回收沿用 server 级 idleTimeout。
// - onDeviceMessage 注入点：R-4（env_report/env_remediated）与 R-5（tool_result）在此扩展。
import type { Hono } from "hono";
import type { ServerWebSocket } from "bun";
import type { UserStore } from "../auth/store";
import type { RemoteStore } from "../remote/store";
import { DeviceRegistry, type DeviceConnData, type DeviceEntry } from "./registry";

export interface ServeOpts {
  port?: number;
  hostname?: string;
  idleTimeout?: number; // 缺省 255（SSE/设备长连，同 index 现有值）
  userStore: UserStore;
  remote: RemoteStore;
  registry?: DeviceRegistry; // 缺省自建；共享告警：routes 的 deps.deviceRegistry 应与之一致（logout 关连）
  /** 设备 → server 消息分发（R-4/R-5 扩展；缺省只回 ping/pong）。 */
  onDeviceMessage?(entry: DeviceEntry, msg: unknown): void;
  /** 设备连接关闭（含被顶号/断线）通知——R-5 在飞工具调用失败挂这里。 */
  onDeviceClose?(entry: DeviceEntry, code: number, reason: string): void;
}

export interface ServerHandle {
  port: number;
  /** http://127.0.0.1:<port><path> */
  url(path?: string): string;
  /** ws://127.0.0.1:<port><path> */
  wsUrl(path?: string): string;
  close(): void;
  registry: DeviceRegistry;
}

const WS_PATH = "/ws/device";
const bearerOf = (h?: string | null): string | null => (h && h.startsWith("Bearer ") ? h.slice(7) : null);
const DEVICE_ID_MAX = 128;

export function serve(app: Hono<any>, opts: ServeOpts): ServerHandle {
  const userStore = opts.userStore;
  const remote = opts.remote;
  const registry = opts.registry ?? new DeviceRegistry();
  const port = opts.port ?? 0;

  const upgradeDevice = (req: Request, server: { upgrade(a: Request, o?: { data?: unknown }): boolean }): Response | undefined => {
    if (new URL(req.url).pathname !== WS_PATH) return undefined; // 非设备路径 → 交 HTTP
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const token = bearerOf(req.headers.get("authorization"));
    const deviceId = req.headers.get("X-Device-Id");
    if (!token || !deviceId || deviceId.length === 0 || deviceId.length > DEVICE_ID_MAX) {
      return new Response("unauthorized", { status: 401 });
    }
    const u = token && deviceId ? userStore.resolveToken(token) : null; // 停用用户 resolveToken 已返回 null（status=active 才 hit）
    if (!u) return new Response("unauthorized", { status: 401 });
    const ok = server.upgrade(req, { data: { userId: u.id, deviceId, token } });
    if (!ok) return new Response("upgrade failed", { status: 400 });
    return undefined; // 已接管（不再走 HTTP 响应）
  };

  const websocket: BunWebSocketHandlers = {
    open(ws) {
      const d = ws.data as DeviceConnData;
      remote.upsertClient({ userId: d.userId, deviceId: d.deviceId }); // 联机真实翻转（last_seen 刷新；连接时刻为准）
      registry.register({ userId: d.userId, deviceId: d.deviceId, token: d.token, ws });
    },
    message(ws, raw) {
      const d = ws.data as DeviceConnData;
      const entry: DeviceEntry = { userId: d.userId, deviceId: d.deviceId, token: d.token, ws };
      remote.upsertClient({ userId: d.userId, deviceId: d.deviceId }); // 任何消息视为活跃（last_seen）
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return; // 非 JSON 帧忽略（无密文通道，明文信封）
      }
      if ((msg as any)?.type === "ping") {
        try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* 写失败交给 idleTimeout/close */ }
        return;
      }
      opts.onDeviceMessage?.(entry, msg);
    },
    close(ws, code, reason) {
      const d = ws.data as DeviceConnData;
      registry.detach(d.userId, ws);
      // 离线语义：本连接关闭后，只要没有「同设备新连接仍在线」，该设备即离线。
      // - 客户端主动 close：无现存连接 → 离线
      // - 被顶号（换设备挤掉）：现存=新设备 → 旧设备离线
      // - 同设备重连覆盖：现存=同 deviceId 新连接 → 不误标
      const cur = registry.get(d.userId);
      if (!cur || cur.deviceId !== d.deviceId) remote.setClientOffline(d.userId, d.deviceId);
      opts.onDeviceClose?.({ userId: d.userId, deviceId: d.deviceId, token: d.token, ws }, code, reason); // R-5：在飞工具调用失败
    },
  };

  const server = Bun.serve({
    port,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: opts.idleTimeout ?? 255,
    fetch(req, srv) {
      const wsResp = upgradeDevice(req, srv);
      if (wsResp) return wsResp;
      return app.fetch(req);
    },
    websocket: websocket as any,
  });

  const base = (scheme: string, path = "") => `${scheme}://127.0.0.1:${server.port}${path}`;
  return {
    port: server.port as number, // Bun.Server.port 类型 number|undefined；实际已绑定实端口（port:0 亦然）
    url: (p = "") => base("http", p),
    wsUrl: (p = "") => base("ws", p),
    close: () => server.stop(true),
    registry,
  };
}

/** 内部定型：与 Bun WebSocketHandler 结构一致（位类型卫生兜底）；DeviceConnData 使 ws.data 具型。 */
type BunWebSocketHandlers = {
  open(ws: ServerWebSocket<DeviceConnData>): void;
  message(ws: ServerWebSocket<DeviceConnData>, message: string | Buffer): void;
  close(ws: ServerWebSocket<DeviceConnData>, code: number, reason: string): void;
};