# Spike A · Pi 执行层 — 实测结果（darwin 侧）

> 关联：`docs/spikes/spike-a-pi-execution-layer.md`（设计）、`learnings/pi-headless-extension-ui-handshake.md`（头号风险）、ADR 0001/0003（待立）
> 环境：macOS darwin · pi v0.83.0 · model `go/deepseek-v4-flash`。**prod=Linux+bwrap 未在此测**（待 Linux 环境）。

## 结论：dev/darwin 侧可行 ✅

驱动（oneshot+rpc）、并发排队、写隔离、清洗器全部跑通。头号风险 **D1（无头驱动卡死）在本场景不触发**（见发现 C）。**D4 写隔离成立**；读域 macOS 偏弱，prod 用 bwrap 命名空间解决。

## 各步实测

**步骤1 oneshot（`pi -a -ne -p --mode json`）** — NDJSON 成立（session→agent_start→turn_start→message_start/end×2→message_update(text/thinking delta)→turn_end{toolResults}→agent_end{messages}→agent_settled）。assistant 含 `thinking`+`text` 两块→解析只取 text。无 UI 请求、无卡死。

**步骤2 rpc（`pi --mode rpc` + 手写 JSONL reader + UI 应答器）** — PONG、多轮+工具调用（bash echo 拿回输出）、`agent_settled` 全跑通。**rpc 正常流式 text_delta**（22–60 事件）；最终文本也可从 `agent_end.messages` 权威取。UI 应答器按 `rpc.md` 实现（dialog→deny/cancel，fire-and-forget→忽略）；PONG/工具调用都不触发 dialog。

**步骤3 并发** — 流式中朴素再发 prompt → `success:false, "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')..."`；`streamingBehavior:"followUp"` → `success:true`（排队）。→ 队列 catch 该 error（`PiAlreadyProcessing`）或主动用 followUp/steer。

**步骤4 sandbox-exec 写隔离（macOS，subpath 用 realpath）**

| 向量 | 结果 |
|---|---|
| 写 workdir 内 | ✓ ALLOWED |
| 写 workdir 外 / `..` / `/tmp` / `cd /` 后写 | ✓ BLOCKED |
| 读 symlink-out（cat） | ALLOWED（**读域弱**，macOS 已知短板） |
| 写 hardlink-out | **ALLOWED = 逃逸**（macOS；prod bwrap 挡，源未挂载） |

**步骤5 WORKDIR 清洗器** — 检出 symlink-escape（`leak-symlink.txt`→外）并拒启动 ✓。hardlink 靠 realpath 检测不到（它就是该文件）→ 靠沙箱挡。

## 关键发现（影响设计）

- **A｜坏扩展硬阻启动**：项目装的 `tavily-core.ts` 导出无效 → 所有 pi 启动失败。**根治**：不全局 `pi install`，按需 `-ne` + `-e`/`--skill` 显式加载；**Tavily 折成 skill**（自带扩展，按需加载）。〔用户已认〕
- **B｜key 解析相对 cwd**：`models.json` 的 `apiKey:"!grep .env"` 相对 cwd；与「cwd=项目工作区」冲突。**已验证解法**：`--provider go --model deepseek-v4-flash --api-key "$GO_API_KEY"`（env 注入），cwd 可任意。dev/prod 统一 env 注入。〔用户已认〕
- **C｜D1 卡死面比预想窄**：headless rpc + `-a` 下，普通对话与工具调用**不产生 UI dialog**；阻塞 dialog 只来自扩展主动调 `ctx.ui.*`。应答器是安全网。（"rpc 不流式"是 key 失败的假象，已被原始数据推翻。）
- **D｜seatbelt profile 两个坑**：① `mach-lookup*`/`network*`/`sysctl*` **非合法操作类** → profile parse 失败、silently 全拒（看着像"过紧"实则是 parse 挂）。② subpath **必须 realpath 规范路径**（`/tmp`→`/private/tmp`；`/Volumes` 亦然）。

## 量测
- rpc PONG 往返 ~5.6s（settled）；含工具调用 ~12.7s。
- 单进程 RSS ~151MB（沿用风险登记 agent 实测）。

## 未覆盖 / 待补
- **prod Linux+bwrap 决定性隔离测试**（待 Linux 环境）：`bwrap --unshare-all` + bind workdir + seccomp(block `CLONE_NEWUSER`/`TIOCSTI`) + WORKDIR 清洗 → 验 read 域也隔离、hardlink 逃逸被挡、pi/node 能起。
- **pi 在沙箱内端到端实跑**：本次沙箱用 `sh` 验机制；pi-in-sandbox 需 profile 加合法 network/mach 语法（供模型 API）后补测。
- 会话盘占四段式（限长+压缩+完整归档+提 learning）未在本次测。
- in-process `AgentSession` 路线（D1 备选）未取——已选子进程+沙箱。

## 产出文件（throwaway，可删）
`spikes/spike-a/`：`rpc-driver.mjs`、`rpc-concurrency.mjs`、`sandbox-test.sh`、`sanitize.mjs`。
