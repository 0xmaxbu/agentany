# 0033 - remote 工作流执行与设备入网：per-tool remote 转发 + device-login 单机登录 + preflight 挂起-自动续 + workflow 授权

日期：2026-08-20（grill-with-docs grilling 定稿 → 实施 spec：issue #71「spec: remote-workflow v1」）

## 状态

已接受（实施 spec = issue #71，`ready-for-agent`）

## 背景

服务器自身执行不了一部分工具：要显卡的推理、Windows 图形桌面操作等，在无 GPU / 非 Windows 的服务器上**注定失败**，而这些能力真实存在于团队成员的远端机器（工作站、带显卡的机器、Windows 桌面）。现状缺口：

- 服务器**无远端设备概念**：无 WebSocket、无设备身份/入网授权；工具只能作为 pi 扩展从服务端注入、在本地 pi 子进程执行——远端算力接不进来。
- **无启动检查**：设备在不在线、环境齐不齐都无从判定，启动即空转或未知失败。
- **无 per-user 工作流授权**：现有 `SECURITY_POSTURE` 是环境变量级的 per-workflow allow/deny，非按用户配；schema 里预留的 `roles?: string[]` 未实现（角色仅 admin/member，项目角色是 step-c TODO）。
- **双真身**：根目录 `workflows/*.md` 是 `apps/server/src/workflows/*.ts` 的衍生物（文件自标"人类可读规格（衍生物）"）、全库零运行时引用，长期漂移。

与 ADR-0002 的关系：0002 是针对 **computer-use 单一场景**（桌面上限）把 pi-computer-use 的 native helper 传输网络化（v2 桌面客户端）；本篇是**概括机制**——任意 remote 工具 + 设备入网/鉴权/预检/授权，可为 0002 的桌面客户端接入提供统一的入网层与鉴权。

## 决策

**D1 · 统一真身**：工作流定义以代码为唯一真身；删根目录 `workflows/{brand-research,brand-strategy-analysis,synthetic,README}.md`（规格/红线/测试指向已沉淀在 `docs/adr/`、`CONTEXT.md`、`skills/{name}/SKILL.md`）。

**D2 · 定义扩展 + 工具注册表**：`Workflow` 在现有 `defineWorkflow` 之上增 `tools: string[]`（本工作流会用的全部工具名）与 `environment?: EnvRequirement[]`；`extensions: string[]` **保留**（按需注入 pi 扩展，chat 与 workflow 各自只注入自己需要的、不全量加载）。新增全局工具注册表 `{name, argsSchema, remote}` 为唯一 schema/属性真相；实现遵循可序列化 `schema.ts`、生成 pi 扩展时桥接 pi 侧 TypeBox（实现细节）。remote 工具由服务端据注册表生成 **pi stub 扩展**（handler=转发）。

```
EnvRequirement = {
  id: string;          // 稳定标识（如 'ffmpeg'）
  name: string;        // 人读名
  check: string;       // 设备上执行的 shell 探测命令（exit 0 = 通过 / stdout 匹配约定）
  autoInstall: string | null; // 有值=软件因素可自动补全；null=装不了，硬失败
  hint?: string;       // 缺失时向设备用户展示的说明
}
```

**D3 · 执行模型（per-tool 自动转发）**：remote 工具 = 本应在服务端执行但受服务器限制注定失败 → 打 `remote` 标；tool_call 被程序化识别并自动转发。链路：pi（stub handler）→ 现有桥接（nonce、loopback）→ 服务端 → WS → 设备执行 → 结果逆路径回 pi。**pi 子进程照旧在服务端跑标准 agentic loop，步骤编排/挂起/续跑语义完全不变**。转发中设备掉线/超时 → 该工具调用失败 → run 失败并写原因；v1 不做自动重试/断点续跑（backlog）。

**D4 · 设备身份与入网**：客户端用用户账号经 `POST /auth/device-login` 登录（复用 argon2 校验 + 现有 `auth_tokens`）→ 返回长效 token + 落 `remote_clients` + 触发**单机顶号**（同账号已有在线设备 → 服务端主动关闭旧连接）。WS endpoint upgrade 阶段验证 token（用户 `status=active` + token 有效）后才升级连接；心跳保活；断线重连**必须重验 token**（仍有效且未被顶号）。logout 撤销 token + 设备标记离线。**单机登录只约束设备客户端之间，不牵动网页/聊天端会话**。

**D5 · 数据模型（四表新增，drizzle 迁移）**：

```
remote_clients(user_id fk, device_id text, device_name, last_seen, status online|offline; UNIQUE(user_id, device_id))
workflow_grants(workflow_id text, user_id fk; PK(workflow_id, user_id))   -- 默认锁定：无授权行 ⇒ 仅 admin
workflow_cfg(workflow_id text PK, enabled bool default true)
pending_starts(id uuid PK, workflow_id, user_id fk, device_id, env_status waiting_remediation|ready|cancelled|failed, reason, created_at, ttl_at)
```

WS 连接的**同步状态**（在线设备、每设备单连接）放内存 registry，不落库；`remote_clients` 承载可持久化的用户↔设备身份与离线痕迹。

**D6 · 启动前置检查（preflight）**：位置在 `RunLifecycle.start` 最早处（validate/建 run 之前）。**非 remote 工作流零影响**（不走任何检查）。remote 工作流三连：① 是否含 remote 工具（查注册表）；② 发起用户的设备是否在线（单机登录 ⇒ 每用户至多一在线设备，唯一）；③ 设备环境检测：发 `check_environment` RPC（一次跑完全部 `check`）返回结果表，三态 `pass` / `fail_hard`（缺且 `autoInstall=null` → 拒启动）/ `fail_installable`（进入 D7）。

**D7 · 挂起-自动续（环境补全）**：`fail_installable` → 建 `pending_starts`（`waiting_remediation`），启动调用返回"等待设备补全环境"。设备侧弹窗**先展示将执行的安装命令与缺失表格**→ 本地设备用户同意 → 执行 `autoInstall` → 上报 `env_remediated`（approved）→ 服务端**自动复检**（重跑 `check_environment`）→ 通过则移除 pending、自动建 run 续跑；拒绝 / TTL 超时 → pending 置 cancelled/failed 并按原渠道告知。chat 场景：turn 先回"挂起等待设备补全环境"，run 开跑后经现有事实事件（`run_started` 等）与块流送达；期间用户可用现有 `read_run` 查状态。

**D8 · 失败即通知**：无独立通知系统——被拒启动=**启动调用直接报因**：chat `start_workflow` 桥工具把原因返回 pi（对话呈现）、HTTP `POST /workflows/:id/runs` 返回 4xx+原因、bridge `/run/start` 返回错误给调用方 run。

**D9 · 授权与管理**：`workflow_grants` 按用户授权；`RunLifecycle.start` **单一校验点**（admin 或已授权放行，否则 4xx），三入口（chat 桥工具 / bridge /run/start / HTTP POST /workflows/:id/runs）全部汇到该点、一处生效。`workflow_cfg.enabled=false` 之已启→停：**拦新开、不打断进行中 run**。admin 新增「工作流」管理页最小集（复用现有 admin 页面骨架）：列表/启停开关/授权管理（搜用户→加/撤）；**不做**在线编辑定义、版本管理；执行记录沿用现有 run 列表/日志。`autoInstall` 命令随工作流代码维护，客户端只展示命令文本 + 征得本地设备用户同意后执行（命令对设备用户透明可见）。

**D10 · 结果与文件通道**：WS 控制面只传小 JSON——`check_environment` / `env_report` / `env_remediated` / `tool_call` / `tool_result` / `ping`/`pong`，全部请求用 correlationId 关联、服务端 async-map 等待。大文件数据面由设备经认证 HTTP（设备 token）上传到该 run 对应工作区（落 `runId` 目录），结果带相对路径；pi / chat / 文件预览无感。

**D11 · 运行期绑定与并发**：run 绑定发起用户设备；单设备一条 WS，同账号并发多 run **复用同一连接**。中途断线 / 被顶号 → 在飞 `tool_call` 失败 → run 失败、日志写原因。

## 负决策

- **不做设备能力（GPU/OS/版本）强制匹配** 与**跨用户设备池调度**：v1 仅查在线、绑定发起人设备（Q8 选 a；共享机器池后置）。
- **不做工具长任务进度流式回传**：v1 同步等待最终结果。
- **不做中途掉线自动重试/断点续跑**：run 失败后手动重跑（"后期优化以提适配性"列入 backlog）。
- **不用 `roles?: string[]` 做授权**：角色仅 admin/member 两档、项目角色未实现，授权按用户落 `workflow_grants`。
- **不建独立"通知系统"**：拒启动=调用报因，无平铺消息通道（D8）。
- **不做 autoInstall 命令签名链/审计**：以"作者可信 + 设备用户知情同意"双约束收敛；审计记录入 backlog。
- **环境补全交互不做进 IM 通道**：设备弹窗仅限客户端本地 UI。
- **单机登录不扩到网页/聊天端**（D4 边界）。

## 后果

- 破坏性变更：根 `workflows/` 四份 md 删除（资料已迁移，见 D1）；演进为"代码唯一真身"。
- Schema：新增四表（D5）+ workflow 定义类型扩展 + 全局工具注册表模块；drizzle 一版迁移。
- 执行面：remote 走新分支（D3/D8/D10）；非 remote 路径与既有行为完全不变（设防实证）。
- 测试：**单 seam**——真端口 `serve(app,{port:0})` 助手 + 脚本化假设备 WS 客户端，覆盖 device-login/单机顶号/重连重验/WS 拒绝、preflight 三态、pending 自动续与 TTL、工具往返落日志、文件上传落 cwd、授权/停用、**非 remote 回归护栏**（先行惯例：`workflows.http.test.ts`、`auth.test.ts` 两态、`feishu-long-connection.test.ts`）。
- 衔接 ADR-0002：本机制的设备入网/鉴权/设备池可作 computer-use 网络化桥的**入网层**（届时复用本鉴权与连接 registry）。
- Backlog：进度流 · 掉线续跑/重试 · 设备能力匹配 · 设备池调度 · autoInstall 审计 · 环境补全通知进 IM。
- 落地顺序（供排期）：① 数据层四表 + 注册表 + 定义扩展（含 md 删除）→ ② device-login + WS 入网与顶号 → ③ preflight + 授权/启停校验与 admin 页 → ④ 环境挂起-自动续 → ⑤ remote 转发 + 文件上传（每步带 seam 测试）。

## 关联

ADR-0002（远程 computer-use 网络化，桥接入本入网层）、0009（薄桥 + nonce）、0011（操作授权/安全，授权模型延伸）、0014（真 auth、token）、0019 / 0025 / 0026（块 / run 挂起 / 事实事件——环境挂起在建 run 前、**不混淆** run 挂起语义）、0030 / 0031（store 原子 + `RunLifecycle` 组合根承载 preflight/授权校验、`appendStep` 原子）。实施 spec：issue #71（PRD，`ready-for-agent`）。