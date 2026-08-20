// 远端执行域 store（ADR-0030 原子切片风格；ADR-0033/R-1 决策 5）：四表最小读写。
// 引擎外唯一耦合 db 的本域文件；装配点进 createStores（stores.ts）。
import { and, count, eq, lt } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { pendingStarts, remoteClients, workflowCfg, workflowGrants } from "../db/schema";
import { now } from "../db-utils";

export type RemoteClientStatus = "online" | "offline";
export type PendingStatus = "waiting_remediation" | "ready" | "cancelled" | "failed";

export interface RemoteClientRow {
  userId: string;
  deviceId: string;
  deviceName: string | null;
  lastSeen: string;
  status: RemoteClientStatus;
}

export interface PendingRow {
  id: string;
  workflowId: string;
  userId: string;
  deviceId: string;
  envStatus: PendingStatus;
  reason: string | null;
  createdAt: string;
  ttlAt: string;
}

export class RemoteStore {
  constructor(private db: BunSQLiteDatabase<any>) {}

  // —— remote_clients：联机/离线/按用户查（R-2 写，R-3 preflight 在线判定读）——
  /** 登录/连接建立时 upsert（同设备重连覆盖自身；换设备另起一行）。 */
  upsertClient(p: { userId: string; deviceId: string; deviceName?: string | null }): void {
    this.db
      .insert(remoteClients)
      .values({
        userId: p.userId,
        deviceId: p.deviceId,
        deviceName: p.deviceName ?? null,
        lastSeen: now(),
        status: "online",
      })
      .onConflictDoUpdate({
        target: [remoteClients.userId, remoteClients.deviceId],
        set: { deviceName: p.deviceName ?? null, lastSeen: now(), status: "online" },
      })
      .run();
  }

  /** logout / 连接断开：置离线。 */
  setClientOffline(userId: string, deviceId: string): void {
    this.db
      .update(remoteClients)
      .set({ status: "offline", lastSeen: now() })
      .where(and(eq(remoteClients.userId, userId), eq(remoteClients.deviceId, deviceId)))
      .run();
  }

  getClient(userId: string, deviceId: string): RemoteClientRow | undefined {
    const rows = this.db
      .select()
      .from(remoteClients)
      .where(and(eq(remoteClients.userId, userId), eq(remoteClients.deviceId, deviceId)))
      .all();
    return rows[0] ? this.clientRow(rows[0]) : undefined;
  }

  listClientsByUser(userId: string): RemoteClientRow[] {
    return this.db.select().from(remoteClients).where(eq(remoteClients.userId, userId)).all().map(this.clientRow);
  }

  /** R-3 preflight：用户是否存在在线设备。 */
  hasOnlineClient(userId: string): boolean {
    return (
      this.db
        .select({ c: count() })
        .from(remoteClients)
        .where(and(eq(remoteClients.userId, userId), eq(remoteClients.status, "online")))
        .all()[0]!.c > 0
    );
  }

  // —— workflow_grants：增删查（R-3 授权/默认锁定判定 + admin 管理）——
  addGrant(workflowId: string, userId: string): void {
    this.db.insert(workflowGrants).values({ workflowId, userId }).onConflictDoNothing().run();
  }

  /** 撤销；返回是否确有撤销（幂等删无提示）。 */
  removeGrant(workflowId: string, userId: string): boolean {
    return this.db.delete(workflowGrants).where(and(eq(workflowGrants.workflowId, workflowId), eq(workflowGrants.userId, userId))).run().changes > 0;
  }

  isGranted(workflowId: string, userId: string): boolean {
    const rows = this.db
      .select({ wf: workflowGrants.workflowId })
      .from(workflowGrants)
      .where(and(eq(workflowGrants.workflowId, workflowId), eq(workflowGrants.userId, userId)))
      .all();
    return rows.length > 0;
  }

  listGrants(workflowId: string): { userId: string }[] {
    return this.db.select({ userId: workflowGrants.userId }).from(workflowGrants).where(eq(workflowGrants.workflowId, workflowId)).all();
  }

  grantCount(workflowId: string): number {
    return this.db.select({ c: count() }).from(workflowGrants).where(eq(workflowGrants.workflowId, workflowId)).all()[0]!.c;
  }

  // —— workflow_cfg：读写（R-3 启停门）——
  /** 未配置行 ⇒ enabled=true（默认放行）。 */
  getCfg(workflowId: string): { workflowId: string; enabled: boolean } {
    const rows = this.db.select().from(workflowCfg).where(eq(workflowCfg.workflowId, workflowId)).all();
    return rows[0] ? { workflowId, enabled: Boolean(rows[0].enabled) } : { workflowId, enabled: true };
  }

  setEnabled(workflowId: string, enabled: boolean): void {
    this.db
      .insert(workflowCfg)
      .values({ workflowId, enabled })
      .onConflictDoUpdate({ target: workflowCfg.workflowId, set: { enabled } })
      .run();
  }

  // —— pending_starts：建/改/查已过期（R-4 状态机 + TTL）——
  createPendingStart(p: { id: string; workflowId: string; userId: string; deviceId: string; ttlAt: string }): void {
    this.db.insert(pendingStarts).values({ ...p, envStatus: "waiting_remediation", createdAt: now() }).run();
  }

  /** 终态幂等：已离开 waiting_remediation 的 pending 拒绝被并发/过期上报改写；返回是否实际更新。 */
  updatePendingStatus(id: string, envStatus: PendingStatus, reason?: string): boolean {
    const cur = this.db.select({ s: pendingStarts.envStatus }).from(pendingStarts).where(eq(pendingStarts.id, id)).all()[0];
    if (!cur || cur.s !== "waiting_remediation") return false;
    this.db.update(pendingStarts).set({ envStatus, ...(reason !== undefined ? { reason } : {}) }).where(eq(pendingStarts.id, id)).run();
    return true;
  }

  getPending(id: string): PendingRow | undefined {
    const rows = this.db.select().from(pendingStarts).where(eq(pendingStarts.id, id)).all();
    return rows[0] ? this.pendingRow(rows[0]) : undefined;
  }

  /** TTL 扫描：仍 waiting_remediation 且已过 ttl_at。 */
  listExpired(nowIso: string): PendingRow[] {
    return this.db
      .select()
      .from(pendingStarts)
      .where(and(eq(pendingStarts.envStatus, "waiting_remediation"), lt(pendingStarts.ttlAt, nowIso)))
      .all()
      .map(this.pendingRow);
  }

  private clientRow = (r: any): RemoteClientRow => ({
    userId: r.userId,
    deviceId: r.deviceId,
    deviceName: r.deviceName ?? null,
    lastSeen: r.lastSeen,
    status: r.status as RemoteClientStatus,
  });

  private pendingRow = (r: any): PendingRow => ({
    id: r.id,
    workflowId: r.workflowId,
    userId: r.userId,
    deviceId: r.deviceId,
    envStatus: r.envStatus as PendingStatus,
    reason: r.reason ?? null,
    createdAt: r.createdAt,
    ttlAt: r.ttlAt,
  });
}