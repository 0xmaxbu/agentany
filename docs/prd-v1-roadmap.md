# PRD：v1 收尾路线（执行面完整 + 学习闭环 + 自动化）

- 状态：定稿（2026-08-15，经逐项讨论）
- 前置：ADR-0017（分阶段）、ADR-0018（workspace 实体）、ADR-0009（执行面架构）、ADR-0008（学习闭环）
- 本文是 v1 的**总路线图与范围契约**；每个里程碑的具体设计走 spec issue / ADR，本文不重复。

## 1. 产品主张（为什么做 v1）

agentany 是设计公司的**内部 agent 执行面**：非技术成员（设计师、客户经理）在 chat 里用自然语言驱动结构化工作流（品牌调研、战略分析），agent 负责执行、追问、总结，人在关键节点拍板。

**v1 完成的判据**：一个真实用户在浏览器里说「帮我做品牌调研」，系统自动跑调研、要决策时在对话里问、跑完自动总结——全程无开发者介入。这就是「执行面完整」。

## 2. 范围契约

### v1 内（六大里程碑）

| 里程碑 | 内容 | 现状 |
|---|---|---|
| M0 收尾 | #21 会话归档/删除提交收口 | 代码在工作区未提交 |
| M1 管理页 | f4：用户 + workspace 管理 UI（后端端点 c 步已有） | AdminPage 占位 + Sidebar 入口已有 |
| M2 执行面 | slice②：桥接工具 + 异步 run + 事件驱动 turn + HITL 融入 turn + 审批门 | spec #9 定稿但需按 ADR-0018 重写 |
| M3 部署对等 | bwrap/Linux 适配（#3），Seatbelt↔bwrap 双平台等价 | Seatbelt ✅（ADR-0012） |
| M4 定时任务 | cron 触发器：仅触发 LLM 可独立完成的任务（经验蒸馏），不触发工作流；手动调用 + missed 记录 | 无实现 |
| M5 学习闭环 | 经验提取：执行过程 + 反馈 → 蒸馏直写 → 事后 git 检查（ADR-0008） | feedback 表多态挂载已有，蒸馏无实现 |

### 明确出 v1

- **多渠道 HITL**（IM/App）：v1 只做 ChatChannel；`HitlChannel` 接口（`push`/`notifyAnswered`）在 M2 中定义并预留。
- 真实部署运维（监控、备份、CI/CD）——M3 只保证「能对等跑」，不含运维体系。
- ws 级角色/visibility/多级创建权限（ADR-0018 已明记推迟项）。
- 已知安全债务收口（dev 阀、login 限流、token 过期）——M3 前不阻塞，v1 GA 前统一评估。

## 3. 里程碑详述

### M0 — 收尾 #21（归档与删除）

提交工作区现有实现（ADR-0020：archivedAt 软态 + admin-only 硬删全链清理），测试随代码验收。**半小时级，不新开 spec。**

### M1 — f4 管理页

**用户故事**：admin 打开管理页，能开通/注销账号、建 workspace、改名单（allUsers ∨ 成员名单）——全程不碰 curl。

- 实装 AdminPage：用户 CRUD + workspace 建/改/名单三端点的前端绑定。
- 沿用 f2 的栈与设计语言（design-taste-frontend skill）。
- 验收：admin 双流程 E2E 绿；member 无入口不可达。

**为什么排在 M2 前**：轻、可快速收掉；且 M2 验收全程依赖 admin 建 workspace/管用户，先有 UI 省 curl 脚本债。

### M2 — 执行面（最大战役，多切片交付）

**核心架构不变**（#9 定稿的 subagent + EventBus + 事件驱动 turn 照旧，经讨论确认照搬），**scope 模型按 ADR-0018 重写**：

- ~~project/general 二分~~ → **会话一律挂 workspace**（已实现，`ws_company` 缺省）；cwd = workspace 目录（`data/workspaces/<id>`，公司 ws 沿用 `data/general`）；~~PROJECT.md~~ → **项目记忆 AGENTS.md**（L2，术语表已定义）。
- 需专属工作区的工作流在公司 ws 启动时：**chat pi 提示引导换会话**（告知需专属工作区、引导另建挂新 ws 的会话），不在会话内切换/迁移。
- #10（会话 scope）随之**关闭**，其有效内容并入本里程碑；#9 spec 同步修订（修订随首片开工做，不单独占一片）。

切片序（严格依赖序，每片独立验收、E2E 绿才算过）：

1. **桥接通道 + chat-bridge 扩展**（#11+#12 合并做）：3199 + nonce + Seatbelt 端口窄放行；`start_workflow`/`resume_workflow`/`read_run`/`ask_user` 四工具注入 chat pi。
2. **EventBus + 持久流 + POST /messages 202 ACK**（#13）：前端 init 即连长连流，统一承载所有帧；断线恢复 v1 方案（不补 delta，turn done 落库后从 GET messages 恢复）。
3. **RunRegistry + 异步 run + 两级事件**（#14）：run 服务端拥有、不绑 turn 寿命；step 级只推流、run 级触发 turn；重启 running→failed。
4. **自动 turn + 前端进度时间线**（#15）：run 边界事件以非空事件 prompt 模板驱动 chat pi；自动总结无需刷新出现。
5. **HITL 融入 turn + 审批门**：ask_user 立即返回不阻塞；pending 每轮注入追问；判答/归一化/resume 全在 chat pi turn 内；首答为准（FIFO + resume 幂等）；`HitlChannel` 接口落地（v1 仅 ChatChannel）；QM 审批门（`SECURITY_POSTURE` + CommandPolicy，审批只来自人类）。

**验收**（端到端）：#9 的 User Stories 1-13、17-19 逐条过 Playwright E2E（不依赖真 LLM 的 stub 链路 + 一条真 LLM 冒烟）。

### M3 — bwrap/Linux prod 对等（#3）

同一 SandboxSpec 语义在 Linux 用 bubblewrap 落地；CI 或双平台脚本验证 Seatbelt↔bwrap 行为等价（文件系统只读/放行、网络 deny + 3199 例外一致）。**部署形态：Docker**（node 进程 + 数据卷在内，bwrap 在容器内跑——注意 user namespace 嵌套，需在实现 ticket 里验证容器内 bwrap 的可用姿势）。**至此 v1 可在 Linux 服务器部署运行。**

### M4 — 定时任务

**用户故事**：admin 配置每周经验蒸馏等周期性 LLM 任务，到点自动执行，无需人值守。

- **边界（grill 敲定）**：cron **仅触发 LLM 可独立完成的任务**（无人值守、无 HITL 语义），**不触发工作流**（推翻早稿「自动跑品牌调研」设想）。
- **任务形态（Q9 决议）**：定时任务 = 按计划跑一个**内部 skill**（如 `experience-distill`）——起 pi 子进程执行，复用沙箱/超时/审计，服务进程不直连 LLM API。
- **两类 scope**：`system`（跨 workspace，挂系统实体——v1 落地，蒸馏即此类）/ `workspace`（挂单 workspace——**v1 只设计不实现**，chat 建 cron 自然属此类）。Skill 不属于任何 workspace，跨 ws 读写一律走**系统作用域**（见术语表），不建「SYSTEM WORKSPACE」实体（避免给 ADR-0018 无类型纯名单开类型洞）。
- **创建双入口**：chat 对话（LLM 经工具建）/ admin UI——**服务端强制校验 admin 角色**，非 admin 工具调用返 403（注入面不区分，与 M2 审批门同一姿态）。
- **专用系统工具**：系统作用域读写工具放**独立目录**（仿 `chat/extensions/` 先例，如 `system-skills/`），**只在 cron 触发的 pi 运行时注入**——注入面即权限面，普通 chat/工作流 run 的 pi 无此工具。
- 实体：ScheduledTask（scope + cron 表达式 + 任务引用 + 输入模板）；触发=服务内调度器（单进程）。
- **停机错过窗口**：统一只记 missed 不补跑；任务数据（如待蒸馏反馈）留到下次窗口一并处理。
- **所有定时任务支持手动调用**（admin 管理页点跑）。

出 v1：失败重试、补跑、多时区、workspace scope 任务、工作流触发。

### M5 — 学习闭环（ADR-0008）

**用户故事**：用户对一次执行（工作流运行或对话）给出评价/批注 → 系统蒸馏出可复用经验 → 下次 agent 直接受益。

v1 范围（务实闭环，非全自动）：
- **反馈入口（两粒度）**：run 级（对工作流运行整体：文本批注 + 可选评分）+ 消息级（assistant **消息整体**尾部轻量 👍/👎 + 可选备注，不细分到 block）。均落 feedback 表（多态挂载 `workflow_run`/`chat`，表已有）。
- **蒸馏范围（隐私边界）**：只蒸馏**有反馈关联**的执行——反馈=用户显式授权「这条值得看」，天然圈定范围与量；无反馈的执行不进入蒸馏。
- **经验提取**：**每周定时批量蒸馏**（M4 调度器的内置任务、system scope）——读当周新反馈 + 对应 pi session 过程 → 蒸馏结论 → **直接写入** skill `experience.md`（+`learnings/` 审计）→ **事后检查**（不走事前人审：admin 事后看 git diff，不满意 revert）。
- **运行时数据独立 git 仓库**：skill 可写副本、`learnings/`、workspace 工作区等运行时数据放数据卷上的**独立 git 仓库**（与代码 repo 分离，代码走镜像）；蒸馏任务每次跑完**自动 commit**（message 如 `distill: 2026-W33 feedback batch`）并 **push 到远端私库**（防容器丢失）；revert 粒度=一次任务。repo 里的 skills 作种子，部署时随数据卷走。

出 v1：全自动蒸馏、跨 skill 经验推荐、经验质量评估。

## 4. 非目标（整个 v1 不做）

SSO/外部账号体系；移动端；工作流可视化编排器（工作流仍是 coded）；多租户 SaaS 化；IM 渠道。

## 5. 风险与已知债务

| 风险 | 缓解 |
|---|---|
| M2 规模大（五切片、动 chat 接口） | 每片独立验收可停；破坏性改（202 ACK）单独切片、前端同片改 |
| slice② spec 与 ADR-0018 偏差误导实施 | M2 开工前先修订 #9/关 #10（本文 §3-M2 已定口径） |
| 经验蒸馏质量不可控 | M5 事后 git diff 检查可 revert；`learnings/` 审计可回溯 |
| 单进程调度与 run 并发互相影响 | M4 复用 M2 queue 串行模型，不另起并发路径 |
| 未提交的 #21 改动长期悬置 | M0 第一件事提交收口 |

## 6. 完成定义（v1 GA）

M0-M5 全部验收 + 按验收清单冒烟：Docker 部署（Linux + bwrap）下，用户以 **brand-research（全自动）→ 选角度（HITL）→ brand-strategy-analysis** 两工作流串联走完全流程，期间用上 HITL 拍板、事后给出反馈并沉淀一条经验（经 git diff 可查）。

**冒烟执行方式**：由项目所有者本人扮演用户、对照**独立验收清单 `docs/acceptance-v1.md`** 逐项打勾（清单随 M2 各切片验收逐项生长、GA 前定稿；不放 PRD 正文——PRD 是定稿契约不该频繁改）。
