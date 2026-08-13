// macOS Seatbelt 适配器（ticket #2）：sandbox-exec -p <profile> -- <cmd>。
// profile 顺序刻意排成「广 allow → 广 deny → 窄 allow」，使 last-match 与 most-specific
// 两种 Seatbelt 语义都得到同一结果（稳）。deny REPO_ROOT + DATA_DIR 一刀盖住
// .env / db / repo 源码 / 其它项目；窄 allow 放回 skills(ro) + workspace/sessions(rw)。
//
// 参考：/usr/share/sandbox/*.sb（(deny default) / file-read* / subpath / literal / network*）。
import { DATA_DIR, REPO_ROOT, repoSkillsDir } from "../config";
import type { SandboxSpec, SpawnPlan } from "./sandbox";

// Scheme 字符串字面量（路径来自 config，非用户输入；仍转义 " 与 \）。
const q = (s: string): string => JSON.stringify(s);

export function wrapSpawnSeatbelt(spec: SandboxSpec): SpawnPlan {
  const profile = seatbeltProfile(spec);
  return {
    argv: ["sandbox-exec", "-p", profile, "--", ...spec.argv],
    cwd: spec.cwd,
    env: spec.env,
  };
}

function seatbeltProfile(spec: SandboxSpec): string {
  const home = process.env.HOME ?? "";
  const rw = spec.allow.rw;
  const ro = spec.allow.ro ?? [];

  const L: string[] = [
    "(version 1)",
    "(deny default)",
    // 让被约束的命令及其子进程能跑（fs/net 仍由下面规则卡）。
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    // 广读（让二进制加载系统库 / dyld 共享缓存等）。
    "(allow file-read*)",
    // —— 广拒：仓库树 + DATA_DIR（一刀盖 .env / db / 源码 / 其它项目）——
    `(deny file-read* (subpath ${q(REPO_ROOT)}))`,
    `(deny file-read* (subpath ${q(DATA_DIR)}))`,
    // —— 窄 allow 放回：skills(ro) + rw(workspace/sessions) + 额外 ro ——
    `(allow file-read* (subpath ${q(repoSkillsDir())}))`,
    ...rw.map((p) => `(allow file-read* (subpath ${q(p)}))`),
    ...ro.map((p) => `(allow file-read* (subpath ${q(p)}))`),
  ];

  // home：**不广拒** ~——pi/node 装在 ~/.nvm 等处，广拒会让沙箱内 pi 起不来。
  // 只拒凭证子目录 + pi 自身敏感数据（auth.json 的 token、sessions 的会话 transcript）。
  // 注：pi 运行只需 ~/.pi/agent/{settings,models}.json（配置，非密钥）；密钥经 env(printenv) 解析。
  if (home) {
    for (const sub of [
      "/.ssh", "/.aws", "/.gnupg", "/.netrc", "/Library/Keychains",
      "/.pi/agent/auth.json", "/.pi/agent/sessions",
    ])
      L.push(`(deny file-read* (subpath ${q(home + sub)}))`);
  }

  // —— 写：默认全拒，仅 rw 放行 + 常用设备节点 + pi 运行时状态目录 ——
  L.push(`(deny file-write* (subpath ${q("/")}))`);
  for (const p of rw) L.push(`(allow file-write* (subpath ${q(p)}))`);
  // pi 需写 ~/.pi/agent（settings.json.lock 等运行时状态）；auth.json/sessions 的【读】仍拒（见上）。
  if (home) L.push(`(allow file-write* (subpath ${q(home + "/.pi/agent")}))`);
  L.push(
    `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))`,
  );

  // —— 网络：pi 是 AI 引擎，需出站连 provider(HTTPS)——"全禁"会让 pi 取不到模型。
  // 改为：放行出站（provider 可达）+ 禁 loopback（关 SSRF 自驱动到本服务 127.0.0.1:3000）。
  // 本地 listener 测试（nc 127.0.0.1）仍被拒——沙箱测试 #5 验的正是这条。
  // ⚠ 这是对 spec「全禁出站」的必要修正（见 ticket #2 进展注记 / 待用户确认）。
  // Seatbelt 限制：network 地址的 host 只允许 "*" 或 "localhost"（不能写 127.0.0.1）。
  // 故：放行所有出站（provider HTTPS 可达），拒 "localhost"（loopback，关 SSRF 自驱动到本服务）。
  // 已知局限：Seatbelt 无法按 IP/CIDR 细粒度拒（如 10.* 内网）——记为已知缺口。
  if (spec.net === "deny") {
    L.push("(allow network-outbound)");
    L.push(`(deny network-outbound (remote tcp "localhost:*"))`);
    L.push(`(deny network-outbound (remote udp "localhost:*"))`);
    // 窄放行：bridge 端口（per-turn nonce 保护）。排在 deny localhost:* 之后 → last-match 放行
    // （spike 实测 (allow ... "localhost:3199") 压过 (deny ... "localhost:*")）。仅放行指定端口，余 loopback 仍拒。
    for (const port of spec.loopbackPorts ?? []) {
      L.push(`(allow network-outbound (remote tcp "localhost:${port}"))`);
    }
  }

  return L.join("\n");
}
