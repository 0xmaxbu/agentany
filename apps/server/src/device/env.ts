// 设备环境检测 RPC（ADR-0033 / R-4）：check_environment → env_report（correlationId async-map 待响），
// env_remediated（设备用户对挂起补全的同意/拒绝）→ 复检自动续 / 取消。
// 可信性：服务端不信任上报的 status 汇总，从 table 逐项重派 status（fail_hard = 存在不可自动补全的缺失）；
// env_remediated 必须来自 pending 对应设备连接，pending 已终态幂等忽略。
import type { RemoteStore, PendingRow } from "../remote/store";
import type { DeviceEntry, DeviceRegistry } from "./registry";
import type { EventBus } from "../chat/eventbus"; // ADR-0033/R-4 D7：pending 终态按原渠道告知
import { getWorkflow } from "../registry";
// 线帧值类型从 @agentany/ws-protocol 导入（ADR-0034 D2；此处 re-export 兼容旧路径）。
import type { EnvRequirement, EnvCheckItem, EnvCheckStatus } from "@agentany/ws-protocol";
import type { CheckEnvironmentFrame, EnvPendingFrame } from "@agentany/ws-protocol";

export type { EnvRequirement, EnvCheckItem, EnvCheckStatus };

/** env_report 消费端的服务端视角结果（deviceId 为服务端从连接补充，不在线帧上）。 */
export interface EnvReportResult {
  deviceId: string;
  status: EnvCheckStatus;
  table: EnvCheckItem[];
}

/** 单「真值」汇总：服务端从逐项派生，不采信设备声称的 status。 */
export function reportStatusOf(table: EnvCheckItem[]): EnvCheckStatus {
  const hard = table.find((i) => !i.ok && !i.autoInstallable);
  if (hard) return "fail_hard";
  return table.some((i) => !i.ok) ? "fail_installable" : "pass";
}

const ENV_TIMEOUT_MS = 30_000;

interface PendingCheck {
  resolve: (r: EnvReportResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DeviceEnvRpcOpts {
  registry: DeviceRegistry;
  remote: RemoteStore;
  timeoutMs?: number;
  /** 注入工作流解析（复用 lifecycle 的 getWorkflow 注入——测试挂远端 fixture 用）。 */
  getWorkflow?: typeof getWorkflow;
  /** pending 复检通过 → 触发建 run 续跑（index 装配；重入 RunLifecycle.start 剩余流程）。 */
  onReady?(pending: PendingRow): void;
  /** pending 终态（declined/TTL）按原渠道告知（D7 附则；无该依赖 → 不告知）。 */
  eventBus?: EventBus;
}

export class DeviceEnvRpc {
  private checks = new Map<string, PendingCheck>(); // correlationId → 待响
  private seq = 0;

  constructor(private opts: DeviceEnvRpcOpts) {}

  /** 发起环境检测：发 check_environment 并 await env_report（async-map）。设备不在线 → 抛错（=env_fail 语义上层兜底）。 */
  checkEnvironment(userId: string, requirements: EnvRequirement[]): Promise<EnvReportResult> {
    const entry = this.opts.registry.get(userId);
    if (!entry) throw new Error(`device not online for user ${userId}`);
    const id = `env-${++this.seq}`;
    const frame: CheckEnvironmentFrame = { type: "check_environment", id, requirements };
    try {
      entry.ws.send(JSON.stringify(frame));
    } catch {
      throw new Error(`device send failed for user ${userId}`);
    }
    return new Promise<EnvReportResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.checks.delete(id);
        reject(new Error(`env check timeout: ${id}`));
      }, this.opts.timeoutMs ?? ENV_TIMEOUT_MS);
      this.checks.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject,
        timer,
      });
    });
  }

  /** serve() 消息分发：env_report 解 async-map；env_remediated 走补全处理。返回是否已消费（消费≠成功）。 */
  route(entry: DeviceEntry, msg: Record<string, unknown>): boolean {
    if (msg.type === "env_report") {
      const p = this.checks.get(String(msg.id));
      if (p) {
        this.checks.delete(String(msg.id));
        clearTimeout(p.timer);
        p.resolve(this.reportFrom(entry, msg));
      }
      return true;
    }
    if (msg.type === "env_remediated") {
      void this.onRemediated(entry, msg);
      return true;
    }
    return false;
  }

  /** 已超时的在飞检测清理锚（可选调用；超时自动清）。 */
  get inFlight(): number {
    return this.checks.size;
  }

  /** 挂起补全通知（ADR-0038 env 链路）：pending 建立后推 env_pending 给设备——设备用户经 onConsent
   * 同意/拒绝（同意 → 设备跑 items[].autoInstall → env_remediated，本端复检后续跑）。
   * 推送失败/设备不在线 → 静默 false（pending 留 waiting_remediation，TTL sweep 兜底回收）。 */
  notifyPending(userId: string, o: { pendingStartId: string; workflowId: string; items: EnvRequirement[] }): boolean {
    const entry = this.opts.registry.get(userId);
    if (!entry) return false;
    const frame: EnvPendingFrame = { type: "env_pending", pendingStartId: o.pendingStartId, workflowId: o.workflowId, items: o.items };
    try {
      entry.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private reportFrom(entry: DeviceEntry, msg: Record<string, unknown>): EnvReportResult {
    const raw = (msg.result ?? {}) as { table?: unknown[] };
    const table: EnvCheckItem[] = Array.isArray(raw.table)
      ? raw.table.map((it: any) => ({
          id: String(it?.id ?? ""),
          name: String(it?.name ?? ""),
          ok: Boolean(it?.ok),
          reason: typeof it?.reason === "string" ? it.reason : undefined,
          autoInstallable: Boolean(it?.autoInstallable),
        }))
      : [];
    return { deviceId: entry.deviceId, status: reportStatusOf(table), table };
  }

  // —— env_remediated：同意→复检（重发 check_environment，pass 才 ready→onReady 建 run）；拒绝→cancelled；过期→failed ——
  private async onRemediated(entry: DeviceEntry, msg: Record<string, unknown>): Promise<void> {
    const pendingId = String(msg.pendingStartId ?? "");
    const approved = Boolean(msg.approved);
    const remote = this.opts.remote;
    const pending = remote.getPending(pendingId);
    if (!pending || pending.envStatus !== "waiting_remediation") return; // 已终态/未知 → 幂等忽略
    if (pending.userId !== entry.userId || pending.deviceId !== entry.deviceId) return; // 来源设备不匹配 → 忽略
    if (pending.ttlAt < new Date().toISOString()) {
      remote.updatePendingStatus(pendingId, "failed", "ttl_expired"); // 惰性 TTL 兜底
      this.notify(pending, "failed", "ttl_expired");
      return;
    }
    if (!approved) {
      remote.updatePendingStatus(pendingId, "cancelled", "declined_by_device");
      this.notify(pending, "cancelled", "declined_by_device");
      return;
    }
    // 复检：重发 check_environment，要求 pass 才 ready
    const wf = (this.opts.getWorkflow ?? getWorkflow)(pending.workflowId);
    const requirements = wf?.environment ?? [];
    const report = await this.checkEnvironment(entry.userId, requirements);
    if (report.status !== "pass") {
      if (report.status === "fail_hard") remote.updatePendingStatus(pendingId, "failed", "env_hard_fail_after_remediation");
      // fail_installable → 保持 waiting（可再修再同意）
      return;
    }
    if (!remote.updatePendingStatus(pendingId, "ready")) return; // 并发终态 → 忽略
    this.opts.onReady?.(pending);
  }

  /** TTL sweep：仍 waiting_remediation 且已过 ttl_at 的 pending → failed + 按原渠道告知（boot/定时调；消除永久挂起）。返扫掉数。 */
  sweepExpired(nowIso?: string): number {
    const remote = this.opts.remote;
    let n = 0;
    for (const p of remote.listExpired(nowIso ?? new Date().toISOString())) {
      if (!remote.updatePendingStatus(p.id, "failed", "ttl_expired")) continue; // 并发已终态 → 跳过
      this.notify(p, "failed", "ttl_expired");
      n++;
    }
    return n;
  }

  /** D7 附则：pending 终态（declined/TTL）经原渠道（会话事件流）告知请求方。无会话锚/无 bus → 丢弃。 */
  private notify(pending: PendingRow, outcome: "cancelled" | "failed", reason: string): void {
    const bus = this.opts.eventBus;
    if (!bus || !pending.conversationId) return;
    bus.publish(pending.conversationId, {
      type: "env_pending_status", pendingId: pending.id, workflowId: pending.workflowId, outcome, reason,
    });
  }
}