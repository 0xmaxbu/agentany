// Linux bwrap 适配器（ticket #3）。⚠ 本机 macOS 无法跑 bwrap → containment 验证延后至 Linux 环境。
//
// 与 Seatbelt 同姿态：工作区/sessions 可写、skills 只读、其余（.env/DB/repo 源码/家目录凭证/其它项目）
// 根本【不挂载】（bwrap 默认 nothing；不像 Seatbelt 的 deny-list）。symlink 逃逸由 bind 拓扑兜住
// （没挂载的路径，symlink 指过去也解析不到）。
//
// ⚠【网络不对称 = 当前最大残留威胁】bwrap 网络全有/全无：--unshare-net 会断 provider（pi 挂，除非
// A4 服务端代理）；不 unshare 则主机网络。当前默认主机网络 → Linux 上两缺口【未堵】（Seatbelt/Mac 均已堵）：
// ① loopback SSRF——沙箱内进程可 curl 127.0.0.1:3000 自驱动本服务（防线仅剩 bridge nonce + 真 auth）；
// ② 出站外泄——workspace 内可读内容可 POST 到任意外网（Seatbelt 同样出站全开，非 Linux 独有，但 Mac 至少禁 loopback）。
// 正解 = A4（服务端代理 LLM → --unshare-net 全禁）；文件面（本文件）已收窄，网络面见 #22 / ADR-0012。
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
  // pi 运行时目录 ~/.pi/agent：tmpfs 遮蔽 + 配置文件级 ro-bind（安全修复，ADR-0012 #3 小节）。
  // · tmpfs 挂在 ~/.pi/agent 上 → 真目录（含 auth.json token、sessions transcript）在沙箱内**不存在**
  //   （bwrap 不挂即不存在，symlink 指过去也解析不到）；pi 写运行时锁（settings.json.lock）落 tmpfs，易失无害。
  // · 配置按存在性 ro-bind 放回（settings/models 是 pi 起来的前提；extensions 只读）。
  // 旧方案（整目录 --bind rw）曾让 auth.json/sessions 可读写——与 Seatbelt（deny 读写两者）不对等，已废。
  if (home && existsSync(`${home}/.pi/agent`)) {
    args.push("--tmpfs", `${home}/.pi/agent`);
    for (const f of ["/settings.json", "/models.json", "/models-store.json", "/extensions"])
      if (existsSync(home + "/.pi/agent" + f)) args.push("--ro-bind", home + "/.pi/agent" + f, home + "/.pi/agent" + f);
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
