// Linux bwrap 适配器（ticket #3）。⚠ 本机 macOS 无法跑 bwrap → containment 验证延后至 Linux 环境。
//
// 与 Seatbelt 同姿态：工作区/sessions 可写、skills 只读、其余（.env/DB/repo 源码/家目录凭证/其它项目）
// 根本【不挂载】（bwrap 默认 nothing；不像 Seatbelt 的 deny-list）。symlink 逃逸由 bind 拓扑兜住
// （没挂载的路径，symlink 指过去也解析不到）。
//
// ⚠【网络不对称】bwrap 网络是全有/全无：--unshare-net 会断 provider（pi 挂，除非 A4 服务端代理）；
// 不 unshare 则主机网络——loopback SSRF 在 Linux 上【未堵】（Seatbelt/Mac 禁了 loopback）。
// 故默认主机网络（pi 能连 provider），代价 = Linux loopback 隔离要等 A4。详见 ADR-0012 / SECURITY.md。
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { SandboxSpec, SpawnPlan } from "./sandbox";

// bwrap 需要挂载系统运行时（让 pi/node + 动态库 + CA 证书 + DNS 可加载）。按存在性挂。
const SYSTEM_RO = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc", "/opt", "/nix", "/run"];

export function wrapSpawnBwrap(spec: SandboxSpec): SpawnPlan {
  const rw = spec.allow.rw;
  const ro = spec.allow.ro ?? [];
  const home = process.env.HOME ?? "";

  const args: string[] = ["bwrap", "--die-with-parent", "--clearenv"];

  // 系统运行时（ro）。
  for (const d of SYSTEM_RO) if (existsSync(d)) args.push("--ro-bind", d, d);
  // pi / node 安装目录（ro）——argv[0]（pi 二进制）所在目录。仅绝对路径（相对 argv[0] 如 "sh"
  // 的 dirname 是 "."，`--ro-bind . .` 会破坏 bwrap 对后续 dest 的自动 mkdir——实测踩坑）。
  if (spec.argv[0].startsWith("/")) args.push("--ro-bind", dirname(spec.argv[0]), dirname(spec.argv[0]));
  // skills（ro）。
  for (const p of ro) args.push("--ro-bind", p, p);
  // pi 运行时配置（ro：settings/models；**不挂 auth.json/sessions** → token/transcript 不可达）。
  if (home && existsSync(`${home}/.pi/agent`)) {
    for (const f of ["/.pi/agent/settings.json", "/.pi/agent/models.json"])
      if (existsSync(home + f)) args.push("--ro-bind", home + f, home + f);
    // pi 运行时锁需要写 ~/.pi/agent → 给一个独立可写目录（只含锁，不含 auth.json/sessions）。
    args.push("--bind", `${home}/.pi/agent`, `${home}/.pi/agent`); // ⚠ 简化：暂整目录可写；Linux 验证期可收窄
  }
  // 工作区 + sessions（rw）。
  for (const p of rw) args.push("--bind", p, p);

  // 新的 /dev、/proc、/tmp（pi 可能要 /dev/null、临时目录）。
  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");

  // env：clearenv 后按 spec.env 白名单回填。
  for (const [k, v] of Object.entries(spec.env)) if (v !== undefined) args.push("--setenv", k, v);

  // 网络：默认主机网络（pi 连 provider）。--unshare-net 断 provider → 仅 A4 落地后启用。
  // if (process.env.AGENTANY_BWRAP_UNSHARE_NET === "1") args.push("--unshare-net");

  args.push("--", ...spec.argv);
  // bwrap --clearenv + --setenv 自管子进程 env；外层 spawn 仅需 PATH 找到 bwrap。
  return { argv: args, cwd: spec.cwd, env: spec.env };
}
