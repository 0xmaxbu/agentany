# 0012 — Pi 子进程沙箱（ADR-0011 A1 落地）

Pi 是 agentany 唯一的 AI 引擎，作为子进程运行、自带 bash/read/write/edit。无沙箱时它能 `cat ../../.env`、读 `data/db.sqlite`（全租户）、读其它项目工作区、读 `~/.ssh`、`curl localhost:3000` 自驱动。h1–h10 hotfix 是减速带，**没有真隔离边界**。本 ADR 记 A1 的落地形态：**进程级 OS 沙箱**，把每个 Pi 子进程关进"仅项目工作区可达、密钥/DB/家目录/loopback 不可达"的笼子。

前置：ADR-0011（A1 及 A1–A14 路线）、0005（Pi 加载）、0006（项目隔离）、0009（chat，cwd=项目工作区）。威胁模型与已知局限见 `SECURITY.md`。

## 决策

**进程级沙箱，非容器**：macOS=Seatbelt（`sandbox-exec`，本 ADR）；Linux=bwrap（ticket #3，同接口）。理由：每个 Pi run（chat turn + 工作流 agent 步）都 spawn，进程级开销 ~ms（fork+profile）；容器 per-run 100–500ms 在热路径累加。容器级隔离留作未来 A1.1。

**单一接口 + 平台适配器**（原型已定的类型形状）：
```
type SandboxSpec = { argv: string[]; cwd: string; env; net: "deny"|"allow"; allow: { rw: string[]; ro?: string[] } }
type SpawnPlan = { argv: string[]; cwd: string; env }
wrapSpawn(spec): SpawnPlan   // 逃生阀开→直通；darwin→Seatbelt；linux→bwrap(#3)；其它→抛错
```
接线在 **Pi spawn 单一 chokepoint**（`runPi`）：`spawn(plan.argv[0], plan.argv.slice(1), …)`。runner/业务/工作流引擎零改。`allow.rw=[workspace, sessionDir]`、`allow.ro=[skillsDir]`。

**逃生阀** `AGENTANY_NO_SANDBOX=1`（dev/调试）→ `wrapSpawn` 直通；服务启动 `warnIfNoSandbox()` 显眼告警。未设即默认沙箱。

## Seatbelt profile（macOS）

`deny default` 起步；profile 顺序刻意排成**「广 allow → 广 deny → 窄 allow」**，使 Seatbelt 的 last-match 与 most-specific 两种语义都得同一结果（稳）。要点：
- `(allow process-exec/fork)`、`(allow file-read*)`（广读——让二进制加载系统库/dyld 共享缓存）。
- 广拒 `(deny file-read* (subpath REPO_ROOT))` + `(deny (subpath DATA_DIR))` ——一刀盖 `.env`/DB/repo 源码/其它项目。
- 窄放回 `(allow (subpath skills))`（ro）+ `(allow (subpath workspace/sessionDir))`（rw）——窄覆盖广。
- 家目录：**不广拒**（pi/node 装在 `~/.nvm`，广拒会让 pi 起不来）；只拒凭证子目录（`.ssh`/`.aws`/`.gnupg`/`.netrc`/`Library/Keychains`）+ `~/.pi/agent/auth.json`（token）+ `~/.pi/agent/sessions`（transcript）。
- 写：`(deny file-write* (subpath "/"))` + 窄放行 `workspace/sessionDir` + `~/.pi/agent`（pi 运行时锁 `settings.json.lock` 需要）+ `/dev/null` 等设备节点。
- symlink 逃逸：Seatbelt 按解析后目标路径匹配——symlink 指向 `.env` 仍被 `.env` 所在的 REPO_ROOT 拒规则挡（实测验证）。

## ⚠ 网络策略修正（关键，对 spec 的偏离）

ADR-0011/spec 原定 **"v1 全禁出站"**（理由：chat 纯文本无需网络）。**实测推翻**：pi 自己是 AI 引擎、**直接发 LLM 请求到 provider**（opencode.ai 等），不是服务端代理（那是 ADR-0011 **A4**，未做）。全禁网络 → pi 取不到模型 → 空回复（实测 14.8s 空退，exit 0）。

**修正（用户已认）**：`放行出站 + 禁 loopback`。
- Seatbelt 语法限制：network 地址的 host **只允许 `*` 或 `localhost`**（不能写 `127.0.0.1`/CIDR）。故：`(allow network-outbound)` + `(deny (remote tcp "localhost:*"))` + udp 同。
- **loopback 仍拒**（Seatbelt 的 `localhost` 令牌覆盖 127.0.0.1 IP 直连，实测 `nc 127.0.0.1` 被拒）——SSRF 自驱动到本服务 `127.0.0.1:3000` 关掉。
- **#11 窄修正（bridge 通道）**：chat turn 的 pi 需回调服务端 RPC（3199）。`SandboxSpec.loopbackPorts` 按 tcp 端口窄放行：`(allow network-outbound (remote tcp "localhost:3199"))` 排在 `(deny ... "localhost:*")` **之后**（last-match 放行，spike 实测压过通配 deny）。仅 3199 放行 + bridge 全局 per-turn nonce 闸 + 仅绑 loopback；其余 loopback 仍拒（3000 等公网路由对 pi 不可达）。
- pi 连得到 provider（实测沙箱内 pi 流式回 PONG）。

**残余风险（坦诚，SECURITY.md 已知局限 #11）**：
- 出站放宽——pi 理论可连任意外网主机。但 pi **读不到密钥/DB**（已拒），**无料外发**；且 loopback（对本服务的具体威胁）已关。
- Seatbelt **无法按 IP/CIDR 拒内网段**（10.x/192.168.x）——内网 SSRF 未堵，待 A3/A10。
- 真正"全禁网络"的正解是 **A4**：服务端代理 LLM、pi 无密钥无网。A1 暂走"放行出站+禁 loopback"是 A4 落地前的务实妥协。

## 验证（ticket #2 acceptance）

`test/sandbox.test.ts`（darwin 门控，真实受控 `sh` 进程验隔离外部行为）：
1. `.env` 不可读（带 unsandboxed 基线）✓
2. `DATA_DIR` 下文件不可读（覆盖 db.sqlite；带基线）✓
3. 项目工作区可读写 ✓
4. skills 只读、写被拒 ✓
5. loopback 网络拒（带本地 listener 基线）✓
6. symlink 逃到 .env 被拒 ✓
7. `AGENTANY_NO_SANDBOX=1` → `wrapSpawn` 直通（纯单元）✓

真 pi 冒烟：**沙箱内 pi 流式回 PONG**（pi 在 Seatbelt 内正常跑、连得到 provider）；`AGENTANY_NO_SANDBOX=1` pi 同样 PONG（spawn 接线无回归）。tsc clean。

## 后果

- 每个 Pi 子进程（chat turn + 工作流 agent 步 + cron）默认经沙箱。Pi 能跑 bash 但**够不到密钥/DB/家目录凭证，连不到本服务**——爆炸半径被关进笼子。
- SECURITY.md「已防御」+「已知局限」两表随 A1 落地更新（#1/#4/#8-部分迁入已防御；保留 #2 密钥仍在 env——沙箱只"关"不"藏"；新增 #11 出站放宽）。
- 后续：A4（服务端代理 LLM）让"全禁网络 + pi 无密钥"成立，收口 #2/#11；A3/A10 收口内网/出站细粒度。

## #3 bwrap（Linux）落地状态

`pi/sandbox-bwrap.ts` 已实现并接入 `wrapSpawn` 的 linux 分支（复用 #2 接口/接线/测试骨架）。**containment 验证延后至 Linux 环境**（本机 macOS 跑不了 bwrap）。要点与不对称：
- FS 隔离同 Seatbelt 姿态（默认 nothing；只挂系统运行时/skills ro/workspace+sessions rw/pi 配置；不挂 .env/DB/repo 源码/家目录凭证/其它项目 → symlink 指过去也解析不到）。
- ⚠ **网络**：bwrap 网络全有/全无——`--unshare-net` 断 provider（pi 挂，除非 A4）；默认主机网络 = pi 能连 provider，但 **Linux loopback SSRF 未堵**（Seatbelt/Mac 禁了 loopback）。loopback 隔离要等 A4（`--unshare-net` + 服务端代理）。
- 残留简化项（Linux 验证期收窄）：`~/.pi/agent` 暂整目录可写（含锁；auth.json/sessions 未单独屏蔽）。

## 关联
ADR-0011（A1 路线）、0005/0006/0009、`SECURITY.md`、ticket #2（Seatbelt，本 ADR）、#3（bwrap，代码已接、验证延后）、`learnings/pi-provider-key-resolver-cwd.md`（pi 能从工作区 cwd 跑起来的前提）。
