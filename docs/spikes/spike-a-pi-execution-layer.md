# Spike A — Pi 执行层（驱动 + 沙箱隔离）

> 状态：**设计中（已定稿，待开跑）** · 关联 ADR（待 spike 验过后立）：`0001`(引擎)、`Pi 子进程沙箱隔离`(新)、`0003`(传输)
> 关联风险：D1（Pi 无头驱动）、D3（并发/资源）、D4（隔离击穿）、R6（会话盘占）、头号 learning `pi-headless-extension-ui-handshake.md`

## 目标

证明「能以**沙箱化子进程**跑 Pi、隔离到项目工作区、能稳定驱动它、且**逃不出去**」。这是整个引擎层的可行性背书——不通，引擎不可用、多用户隔离也不成立。

## 范围（最小可弃代码）

1. **沙箱**：OS 级把一个 `pi` 子进程锁在 `<workdir>` 内（prod Linux=bwrap；dev macOS=sandbox-exec）。
2. **驱动**：`runPi()` 雏形——起 `pi` 子进程、实现 `extension_ui_request` 兜底应答器、宽松解析事件流。
3. **生命周期 + 并发**：懒启动、空闲回收、`--session-id` 重连、排队、硬上限、崩溃恢复、盘占兜底。

## 沙箱规格（已闭环，带证据）

**保证**：Pi 子进程对 workdir 外任何路径不可达（相对 `..`/绝对/symlink-out/hardlink-out/`/proc`/bash `cd /` 全挡）。

**机制分 OS**：
- **prod Linux = bwrap（挂载命名空间，结构性强于路径 ACL）**：
  ```
  bwrap --unshare-all --share-net --new-session --die-with-parent \
    --bind "$WORKDIR" /work \
    --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
    --ro-bind /bin /bin --ro-bind /etc/resolv.conf /etc/resolv.conf \
    --proc /proc --dev /dev --tmpfs /tmp --chdir /work -- node … pi
  ```
  + **强制 seccomp**（block `CLONE_NEWUSER` + `TIOCSTI`，CVE-2020-13753 / CVE-2017-5226；用 systemd `SystemCallFilter=` 或 seccomp-bpf，**spike 内定**）+ `--new-session`。只绑 `/etc/resolv.conf`（DNS），不绑整个 `/etc`。
- **dev macOS = sandbox-exec**（Codex/Claude Code 同款）：`(deny default)` + `(allow file-write* (subpath WORKDIR))` + `process-exec/fork` + 服务的 `mach-lookup`。（标 deprecated 但仍是 macOS 唯一 MAC 入口。）

**步骤 0（强制，两种机制都需要）**：启动前**清洗 WORKDIR**——扫 realpath，拒任何逃出该树的 inode/hardlink/symlink（否则两种机制都中招）。

**逃逸测试矩阵 + 预期**：

| 向量 | sandbox-exec | bwrap(`--unshare-all`) |
|---|---|---|
| `../../../etc/passwd` | 解析后拒 | 命名空间外=ENOENT |
| 绝对 `/etc/passwd` | 拒 | ENOENT |
| symlink→外 | 目标再校验→拒 | 目标未挂载→ENOENT |
| **hardlink→外（workdir 内预存）** | **逃出** → 清洗后才挡 | **逃出** → 清洗后才挡 |
| `/proc/1/root` `/proc/self/root` | n/a | `--unshare-pid`+fresh `--proc`→指沙箱根 |
| `bash -c 'cd / && cat …'` | 读仍受策略校验 | `/`=空 tmpfs |

**残余风险 top2**：① workdir 内 hardlink/symlink（靠步骤 0 清洗）；② 缺 seccomp（靠强制加）。
**parity 红线**：dev(sandbox-exec 路径 ACL) ≠ prod(bwrap 命名空间)，**决定性隔离测试必须在 Linux+bwrap 上跑**；macOS 版只算本地便利、不背书 prod。

## `runPi()` 契约

**输入**：`prompt`、`sessionId`、`cwd`（沙箱工作区，必须预清洗）、`skills?[]`、`extensions?[]`、`mode:"oneshot"|"stream"`、`signal?:AbortSignal`、`approve?`（`-a` 预批，压低 UI 请求面）、`timeoutMs?`。

**输出**：
- oneshot：`{text, toolCalls[], toolResults[], messages[], sessionId, usage?, stoppedReason}`。
- stream：异步事件流（typed）：`text-delta`/`tool-call`/`tool-result`/`turn-end`/`done{finalResult}`/`error`。`extension_ui_request` 内部消化、默认不外抛。

**abort**：`signal.aborted` → 发 `{type:"abort"}`（rpc）或杀子进程（oneshot）→ 清理 → `stoppedReason:"aborted"`。

**错误分类（显式，因静默卡死是头号陷阱）**：`PiUIRequestUnhandled` / `PiAlreadyProcessing`（调用方排队，别盲重试）/ `PiCrashed`（会话文件还在、可重连续）/ `PiTimeout` / `PiParseError`（未知 type=忽略，畸形 JSON=记日志续跑）/ `SandboxViolation`（沙箱挡了逃逸，透传）。

**内置要求**：每次 spawn 挂 **UI 请求兜底应答器**（默认：项目信任=批、工具权限=按可配 allow 策略、未知=拒），每个 UI 请求入审计/调试日志。

## 会话生命周期

- **两种进程**：① 工作流思考步=每步一个 oneshot `pi -p` 子进程、跑完即退（跨步连续靠 `--session-id` 续同一 JSONL）；② 闲聊=每会话一个长驻 `pi --mode rpc`。
- **起**：懒启动（闲聊首条消息才起 rpc 进程）。
- **回收**：空闲 N 分钟（如 15）杀 rpc 进程（释放 ~151MB）；下次消息带 `--session-id` 重生——**会话文件是真相源、杀进程不丢对话**。
- **重连/续**：`pi --mode rpc --session-id <convId> --cwd <workdir> …` 重新挂载持久化会话。
- **并发**：一个 session 一个 turn（Pi 强制串行）；闲聊中用户在流式时再发 → **我方排队**（v1，不盲塞 Pi；`steer` 打断插话推迟）。
- **硬上限**：最多 M 个并发 Pi 进程（~M×151MB）；超限→排队背压或回"忙，稍后"。
- **崩溃恢复**：rpc 中途死 → 下条消息带 `--session-id` 重生；在飞 turn 丢失（`PiCrashed`，可重试）。
- **盘占（R6）四段式**：
  1. **限会话长度**——活动会话设上限（条数/token）。
  2. **自动压缩**——逼近上限时调 Pi `compact`（缩活动上下文；注：不缩盘）。
  3. **对话完整归档**——压缩/结束前把**完整对话**转录归档（不丢细节）。
  4. **归档定期分析提 learning**——周期 agent 任务复盘归档、蒸馏进 `learnings/`（模式/失败/可复用结论）。⇒ 这本身就是一个**内部工作流**（候选能力），闭环项目的 learnings 体系。

## 成功判据

- 隔离：矩阵全绿（hardlink-out 经步骤 0 清洗后挡）；在 **Linux+bwrap** 上跑通。
- 驱动：oneshot 拿到 text+toolResults；rpc 一个 prompt 流式回、UI 请求被应答不卡；abort 干净。
- 并发：忙时再发=排队不报错不卡死；杀进程无僵尸。
- 量测：单进程 RSS≈151MB、冷启动到可 prompt 耗时、一轮往返时延。

## 产出

`runPi()` 雏形 + 沙箱启动脚本（bwrap 版 + sandbox-exec 版）+ WORKDIR 清洗器 + 逃逸测试套 + 结果落 `learnings/`。

## 不做（留给后续）

工作流引擎（Spike B）、Hono/前端、鉴权、DB、computer-use；`steer` 插话；seccomp 具体实现（spike 内定）；盘占四段式的"归档→learning 提取"工作流的完整设计（单独工作流）。

## 待开跑前确认

- prod 服务器是否允许 user namespace / bwrap（hardened Linux 可能禁）？
- seccomp 落地方式（systemd `SystemCallFilter=` vs seccomp-bpf）？
