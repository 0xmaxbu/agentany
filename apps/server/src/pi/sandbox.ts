// Pi 子进程沙箱入口（ADR-0011 A1 / ticket #2）。
// 唯一对外接口 wrapSpawn(spec) → SpawnPlan：把 Pi 命令包进 OS 级沙箱。
// 平台适配器藏后（darwin=Seatbelt；linux/bwrap=#3）。dev 逃生阀 AGENTANY_NO_SANDBOX=1 直通。
//
// 沙箱契约（ticket #2）：受控进程仅能 读写 自己的项目工作区 + sessions、只读 repo skills；
// .env / DB / repo 源码 / operator 家目录 / 其它项目 不可达；网络全禁；symlink 逃逸阻断。
import { wrapSpawnSeatbelt } from "./sandbox-seatbelt";
import { wrapSpawnBwrap } from "./sandbox-bwrap";

export interface SandboxSpec {
  argv: string[]; // 将被约束的命令 [bin, ...args]
  cwd: string; // 项目工作区（rw 根）
  env: Record<string, string | undefined>;
  net: "deny" | "allow"; // v1 仅 "deny"
  loopbackPorts?: number[]; // net="deny" 时按端口窄放行 loopback（bridge RPC；ADR-0012 修正）。默认空=全拒。
  allow: { rw: string[]; ro?: string[] }; // rw=[workspace, sessionDir]；ro=[skillsDir]
}

export interface SpawnPlan {
  argv: string[]; // 重写后的命令（如 [sandbox-exec, -p, profile, --, bin, ...args]）
  cwd: string;
  env: Record<string, string | undefined>;
}

/** 逃生阀是否开启（dev/调试）。 */
export function noSandbox(): boolean {
  const v = process.env.AGENTANY_NO_SANDBOX;
  return v === "1" || v === "true";
}

/** 当前平台是否有沙箱适配器（测试门控用）。darwin=Seatbelt；linux=bwrap(#3，验证延后)。 */
export const sandboxPlatformAvailable = (): boolean => process.platform === "darwin" || process.platform === "linux";

/**
 * 把 spec.argv 包进沙箱，返回实际要 spawn 的 (argv, cwd, env)。
 * 逃生阀开 → 直通（不包）。未知平台 → 抛错（不静默裸跑；测试请按平台门控）。
 */
export function wrapSpawn(spec: SandboxSpec): SpawnPlan {
  if (noSandbox()) return { argv: spec.argv, cwd: spec.cwd, env: spec.env };
  switch (process.platform) {
    case "darwin":
      return wrapSpawnSeatbelt(spec);
    case "linux":
      return wrapSpawnBwrap(spec); // ticket #3（containment 验证延后至 Linux 环境）
    default:
      throw new Error(
        `sandbox: unsupported platform ${process.platform} (set AGENTANY_NO_SANDBOX=1 to bypass)`,
      );
  }
}

/** 启动时显眼告警（index.ts 调一次）。逃生阀开 = 裸跑，勿公网暴露。 */
const warned = { done: false };
export function warnIfNoSandbox(): void {
  if (noSandbox() && !warned.done) {
    console.warn("[sandbox] AGENTANY_NO_SANDBOX=1：Pi 子进程裸跑、无隔离（勿公网暴露）");
    warned.done = true;
  }
}
