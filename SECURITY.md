# SECURITY.md — agentany 威胁模型与已知局限

**范围声明**：agentany 当前面向**单组织内部受信用户**的 dev/早期形态。**不是**已加固的公网或多租户服务边界。在真 auth（ADR-0011 A2）+ Pi 沙箱（A1）落地前，**不得公网暴露**（默认绑 127.0.0.1）。

本文仿 QM 的坦诚风格：明示信任假设、已防御项、与**已知局限**（我们不防御什么）。

## 信任边界与 operator 假设

1. **Operator 受信（root+key）**：我们不防御恶意/被攻陷的 operator。
2. **当前 dev = 单用户桩、无真鉴权**：任何能访问服务端口者即 `dev-user`（全权）。**仅 loopback**。设 `AGENTANY_DEV_TOKEN` 可加一道 Bearer 闸。
3. **Agent + Pi 子进程不被信任做 authz 决策**：Core（服务端）在其外执行 identity/scope/tier 决策（ADR-0011）。Pi 是 coding agent（有 bash/read/write/edit），**按"能跑 bash = 能读其进程内一切 secret"对待**。
4. **上传文档 / tavily 网页 / tool 结果 / feedback / experience.md = 不受信数据**：身份证明来源，**不等于内容安全**。当前无分类器筛选（defer，见已知局限）。
5. **tavily 网关（`tavily.sharyuke.com`）是第三方出站/信任边界**：所有 query/urls 经它，操作者可见；被攻陷可作注入入口。

## 已防御（本安全审查后落地的 hotfix，代码级）

| # | 防御 | 位置 |
|---|---|---|
| h1 | `projectId` 严格正则 + 路径落 `DATA_DIR/projects/` 断言（防 `../`、绝对路径注入 cwd/sessionDir） | `config.ts` `assertValidProjectId`、`runs.ts` |
| h2 | `startRun` 按 `inputSchema` 校验 input；brand/region `slugify` 进路径；caller-supplied `anglesPath` 解析后须落项目工作区内（防跨项目/任意文件读）（防 prompt/路径注入） | `runs.ts`、`brand-*.ts` |
| h3 | Pi 密钥**不走 argv**（pi 从 env 读）；子进程 **env 白名单**（排除未来 TURN_SECRET/DB 凭据） | `pi/runPi.ts` |
| h5 | 默认绑 `127.0.0.1`；`AGENTANY_DEV_TOKEN` Bearer 闸；body 上限中间件（content-length） | `index.ts`、`auth-stub.ts`、`app.ts` |
| h6 | `DATA_DIR` 单一来源（修 db/client 与 config 不一致 bug） | `db/client.ts` |
| h7 | resume **per-runId 串行锁**（防并发 resume 双执行 TOCTOU） | `workflow-engine/runner.ts` |
| h8 | `runId` 强制 `crypto.randomUUID`（去 `Math.random` 弱 fallback） | `runs.ts` |
| h9 | 全局 **Pi 并发信号量**（默认 4 + 队列上限 → 429，防无界 spawn DoS） | `pi/runPi.ts` |
| h10 | `PRAGMA foreign_keys=ON`（待 FK 约束补进 schema 生效） | `db/client.ts` |
| **A1** | **Pi 子进程沙箱**（macOS=Seatbelt `sandbox-exec`，ticket #2；Linux=bwrap，#3）：Pi 仅可读写**项目工作区+sessions**、只读 `skills`；`.env`/DB/repo 源码/家目录凭证/其它项目 不可达；**loopback 禁**（SSRF 自驱动关）；symlink 逃逸阻断；逃生阀 `AGENTANY_NO_SANDBOX=1`（启动 warn） | `pi/sandbox.ts`、`pi/sandbox-seatbelt.ts`、`pi/runPi.ts`、`test/sandbox.test.ts` |
| **#18** | **QM 审批门**：`start_workflow` 桥接路径经 `CommandPolicy`（`SECURITY_POSTURE`=`dangerous/auto/strict`，默认 auto、fail-closed）；require_approval→复用 `hitl_questions` 发审批卡，**只人类**经 main app `POST /approvals/:id/decide` 批准（bridge 无此端点 + pi 沙箱禁 main app loopback → pi 无自批路径）；审批记录落 DB（`kind/decidedBy/runId` 审计，CAS 防双击） | `security/policy.ts`、`runs/registry.ts`、`routes/approvals.ts`、`db/schema.ts`(0006) |

**待手动 ops**：`chmod 600 .env` 与 `data/db.sqlite`（减少全局可读面）。

## 架构改（ADR-0011 A1–A14）

A1 已落地（macOS/Seatbelt，ticket #2）。其余是**真正的隔离边界**，hotfix 只是减速带：

- ~~**A1 Pi 沙箱**~~ → **已落地（macOS/Seatbelt，#2）**；Linux/bwrap = ticket #3。
- **A2 真 auth + RBAC + 项目成员**——未做（当前桩）。
- **A3 Pi 网络细粒度隔离**——A1 已关 loopback（SSRF 自驱动）；按 IP/CIDR 拒内网段仍未做（Seatbelt 不支持）。**#11 窄修正**：bridge RPC 端口（3199）按 tcp 端口窄放行 loopback（per-turn nonce 闸），其余 loopback 仍拒。
- **A4 信任材料不进 Pi 可读空间**（LLM 经服务端代理、pi 无密钥无网）——未做。**这是让"全禁网络"成立的正解**；A1 暂走"放行出站+禁 loopback"。
- **A5 gate 用服务端 capability**（opId/tier/handler 服务端拥有，禁自报）——未做（gate 本身待建）。
- **A6 DB 隔离**（Pi 独立 OS 用户无 DB 权 / per-project sqlite / 查询层强制 membership）——未做（A1 沙箱已不让 pi 读 DB 文件，纵深一层）。
- **A7 experience.md 审查门 + per-project 隔离**——未做。
- **A8 命令策略服务端化 + 允许式**——未做（A1 沙箱已兜住命令爆炸半径：pi 能跑 bash 但读不到密钥/连不到 loopback）。
- **A9 skill 完整性**（allow-list + hash-sign）——未做。
- **A10 web 出站筛**（URL allow-list + secret 扫描）——未做。
- **A11 audit 独立 sink**（Pi 不可写）——audit 表本身未建。
- **A12 runId/conversation 绑定**、**A13 taint tracking**、**A14 ask_user provenance**——随切片②+。

## 已知局限（我们**不**防御什么，坦诚）

A1（macOS）已落地；下列在 A2–A14 落地前**成立**（dev 期可接受、prod 前收口）：

1. ~~**Pi 能读宿主文件**~~ → **A1 已堵**：沙箱内 pi 读不到 `.env`/`data/db.sqlite`/repo 源码/家目录凭证/其它项目（含经 symlink）。残余：沙箱内 pi 仍可读系统文件（`/usr` 等），但这些非我们的密钥。**Linux/bwrap 未上（#3）；非 darwin/linux 平台抛错（逃生阀可绕）**。
2. **密钥仍在 Pi 可达 env**：A1 沙箱**只"关"不"藏"**——pi 仍持 `GO_API_KEY`（连 provider 要用），沙箱让它即便见到也无路外发（loopback 拒、读不到更多密钥）。彻底"藏"靠 A4（服务端代理、pi 无密钥无网）。
3. **无真鉴权**：loopback 内任何进程/用户 = 全权；跨项目读写（projectId 由 body、无成员校验）。根因 A2。
4. ~~**localhost SSRF**~~ → **A1 已堵**：沙箱禁 loopback，pi 的 `curl 127.0.0.1:3000` 自驱动被拒（实测 `nc 127.0.0.1` 拒）。**#11 窄修正**：仅 bridge 端口 3199 经 per-turn nonce 放行（pi 回调服务端 RPC，`SandboxSpec.loopbackPorts` 端口级 allow 排在 `deny localhost:*` 之后、last-match 放行）；bridge 仅绑 loopback + 全局 nonce 闸，其余 loopback（3000 等）对 pi 仍不可达。
5. **间接注入无防御**：上传文档/tavily 网页/feedback 可操纵 Pi 调"被许可但非意图"的 op；无分类器。根因 defer(Auto 分类器) + A13。（A1 限制了爆炸半径：注入驱使的 pi 仍读不到密钥/连不到本服务。）
6. **experience.md 持久跨用户/项目投毒**：无鉴权全局 feedback → 提取 LLM → 自动加载，影响所有后续 run。根因 A7。
7. **命令策略在 pi 二进制内、非服务端**：write-then-exec 等仍可绕 pi 内策略；但 A1 沙箱兜住爆炸半径（能跑 bash 但够不到密钥/loopback）。真命令策略靠 A8。
8. **audit 未建且计划在同 sqlite**（可被 Pi 删/伪造——但 A1 沙箱已让 pi 读不到 DB 文件）。根因 A11。
9. **extension 供应链**：`-e` 的 TS 扩展在 Pi 子进程全 node 权限（fs/net/env）；buggy/恶意 = 在沙箱内仍能搞事（但出不去）。真隔离靠 A1+A4。
10. **cron 通道/系统主体**：A1 沙箱同样套用到 cron 跑的 pi（同一 runPi 路径）；scheduler 本身待建。
11. **【新·A1 带来】出站网络放行（非 loopback）**：pi 需连 provider（pi=AI 引擎），故沙箱"放行出站+禁 loopback"而非"全禁"。残余：pi 理论可连任意外网主机，但读不到密钥/DB（无料外发）。且 **Seatbelt 无法按 IP/CIDR 拒内网段（10.x/192.168.x）**——内网 SSRF 未堵，待 A3/A10。
12. **【#18】HTTP `/workflows/:id/runs` 旁路审批门（规格明定）**：该端点走 `startRun`（不经 RunRegistry/CommandPolicy），任何工作流可**不经审批直跑**。它是 dev/调试 + 全自动工作流直通口；chat 经 `start_workflow` 桥接才过审批门。根因 A2——真 auth 后按 principal/channel 判定该端点是否也需经门（届时统一收口）。

## 报告漏洞

内部项目，发现安全问题请在内部渠道报告（暂无公开 bounty）。

## 关联
ADR-0005（Pi 加载）、ADR-0006（项目隔离）、ADR-0007（工作流引擎）、ADR-0008（执行/反馈/学习）、ADR-0009（chat）、ADR-0011（agent 操作授权模型，含 A1–A14）。
