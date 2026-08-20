// 设备连接内存注册表（ADR-0033 / R-2 决策：单机登录——同账号新连接挤掉旧连接）。
// 内存 registry 是「在线真身」（preflight R-3 在线判定 + R-4 环境检测 + R-5 工具转发的寻址面）；
// remote_clients 表是落库语义（last_seen/offline 审计），二者分工在 R-2 起固定。
import type { ServerWebSocket } from "bun";

export interface DeviceConnData {
  userId: string;
  deviceId: string;
  token: string;
}

export interface DeviceEntry {
  userId: string;
  deviceId: string;
  token: string;
  ws: ServerWebSocket<DeviceConnData>;
}

export const KICK_REASON = "kicked_by_another_device"; // 换设备登录：旧设备被顶号
export const RECONNECT_REASON = "reconnected"; // 同设备重连：旧连接被覆盖（非顶号）
export const LOGOUT_REASON = "logout"; // 设备主动登出

export class DeviceRegistry {
  /** user_id → 当前在线设备。单机登录保证每用户至多一项。 */
  private byUser = new Map<string, DeviceEntry>();

  /**
   * 登记新连接：返回被挤掉的旧连接（若有）。
   * - 同 deviceId（同机重连）：覆盖自身旧连接（RECONNECT_REASON，非顶号）
   * - 换 deviceId（别机登录）：挤掉旧连接（KICK_REASON，单机顶号）
   * 原子替换：先登记后关旧（服务端主动 close，可带 reason）。
   */
  register(entry: DeviceEntry): DeviceEntry | undefined {
    const old = this.byUser.get(entry.userId);
    this.byUser.set(entry.userId, entry);
    if (old && old !== entry) {
      const reason = old.deviceId === entry.deviceId ? RECONNECT_REASON : KICK_REASON;
      this.closeEntry(old, reason);
      return old;
    }
    return undefined;
  }

  /** 连接关闭回调：只有当该 ws 仍是 byUser 当前条目时才删（防「新挤旧」时误删新连接）。 */
  detach(userId: string, ws: ServerWebSocket<DeviceConnData>): void {
    const cur = this.byUser.get(userId);
    if (cur && cur.ws === ws) this.byUser.delete(userId);
  }

  /** 查当前在线设备（preflight / env / tool 转发的寻址面）。 */
  get(userId: string): DeviceEntry | undefined {
    return this.byUser.get(userId);
  }

  /** 向该用户当前在线设备发送 JSON（序列化失败返回 false）。 */
  send(userId: string, payload: unknown): boolean {
    const e = this.byUser.get(userId);
    if (!e) return false;
    try {
      e.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      this.closeEntry(e, "send_failed");
      return false;
    }
  }

  /** 主动关闭某用户的在线连接（logout / 吊销等）。 */
  close(userId: string, reason: string): void {
    const e = this.byUser.get(userId);
    if (e) this.closeEntry(e, reason);
  }

  private closeEntry(e: DeviceEntry, reason: string): void {
    try {
      e.ws.close(4000, reason);
    } catch {
      /* ws 已关/半关——忽略 */
    }
  }
}