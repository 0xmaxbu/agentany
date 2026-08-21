// 远端工具转发 RPC（ADR-0033 / R-5）：bridge /run/remote-tool → 设备 WS tool_call → 设备 tool_result。
// correlationId async-map；同一连接多 run 并发复用（条目带 runId 上下文）。默认超时；设备断连/被顶号
// → 在飞调用失败（failAllForUser）；不做自动重试（spec R-5 决策）。schema 随 tool_call 下发（设备侧同名 handler 用）。
// tool_call / tool_result 线帧类型从 @agentany/ws-protocol 导入（ADR-0034 D2 单一真相；此处 re-export 兼容旧路径）。
import type { Schema } from "../workflow-engine/schema";
import type { DeviceEntry, DeviceRegistry } from "./registry";
import type { ToolArtifact, ToolCallResult } from "@agentany/ws-protocol";
import type { ToolCallFrame } from "@agentany/ws-protocol";

export type { ToolArtifact, ToolCallResult };

export interface ToolRpcOpts {
  registry: DeviceRegistry;
  timeoutMs?: number;
}

const TOOL_TIMEOUT_MS = 120_000;

interface Inflight {
  userId: string; // 发起用户（断连只失败该用户设备其在飞）
  resolve: (r: ToolCallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DeviceToolRpc {
  private inflight = new Map<string, Inflight>(); // correlationId → 待响
  private seq = 0;

  constructor(private opts: ToolRpcOpts) {}

  get inFlightCount(): number {
    return this.inflight.size;
  }

  /** 向用户当前在线设备转发工具调用并 await tool_result。设备不在线 → 结构化失败。
   * workflowId 必填（ADR-0038 D2：设备侧授权粒度；调用方从已验 run 取，不信任外传）。 */
  invoke(p: { userId: string; tool: string; args: unknown; schema: Schema; runId: string; workflowId: string }): Promise<ToolCallResult> {
    const entry = this.opts.registry.get(p.userId);
    if (!entry) {
      return Promise.resolve({ ok: false, error: "device offline", code: "device_offline" });
    }
    const id = `tool-${++this.seq}`;
    const frame: ToolCallFrame = { type: "tool_call", id, tool: p.tool, args: p.args, schema: p.schema, runId: p.runId, workflowId: p.workflowId };
    try {
      entry.ws.send(JSON.stringify(frame));
    } catch {
      return Promise.resolve({ ok: false, error: "device send failed", code: "device_send_failed" });
    }
    return new Promise<ToolCallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        resolve({ ok: false, error: `tool timeout: ${p.tool}`, code: "tool_timeout" });
      }, this.opts.timeoutMs ?? TOOL_TIMEOUT_MS);
      this.inflight.set(id, {
        userId: p.userId,
        resolve,
        timer,
      });
    });
  }

  /** serve() 消息分发：tool_result → 解 async-map。返回是否已消费。 */
  route(entry: DeviceEntry, msg: Record<string, unknown>): boolean {
    if (msg.type !== "tool_result") return false;
    const inflight = this.inflight.get(String(msg.id));
    if (inflight) {
      this.inflight.delete(String(msg.id));
      clearTimeout(inflight.timer);
      inflight.resolve({
        ok: Boolean(msg.ok),
        code: msg.code as string | number | undefined,
        stdout: typeof msg.stdout === "string" ? msg.stdout : undefined,
        stderr: typeof msg.stderr === "string" ? msg.stderr : undefined,
        artifacts: Array.isArray(msg.artifacts) ? (msg.artifacts as ToolArtifact[]) : undefined,
        error: typeof msg.error === "string" ? msg.error : undefined,
      });
    }
    return true; // 消费（含未知 id——过期响应不作用）
  }

  /** 设备断连/被顶号：该用户所有在飞调用失败（spec R-5：不做自动重试，run 收尾时载体失联即失败）。 */
  failAllForUser(userId: string, reason: string): number {
    let failed = 0;
    for (const [id, inflight] of this.inflight) {
      if (inflight.userId !== userId) continue;
      this.inflight.delete(id);
      clearTimeout(inflight.timer);
      inflight.resolve({ ok: false, error: reason, code: "device_disconnected" });
      failed++;
    }
    return failed;
  }
}