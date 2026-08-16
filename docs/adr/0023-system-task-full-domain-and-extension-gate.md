# ADR-0023：system 任务全域执行模型——沙箱白名单=工作产物域，越界经专属 extension

日期：2026-08-16 ｜ 状态：已接受（grill 会话定稿，spec #38）

## 背景

spec #38（admin 经 UI 建/改 system 定时任务）需要定义 system 任务的执行范围与权限模型。system 任务=LLM 自由执行的 prompt 驱动、无人值守跑在共享数据上——需要任务级最小权限约束（防间接执行面：prompt injection 导致的预期外读写），而非防 admin 本人。

## 决策

### 1. System Workspace=逻辑概念（项目全部域），非实体 workspace

- 不占 ws 表、无名单/权限、UI 无范围选择器——system 任务天然全域。
- **全域的精确边界=全部 ws 的 workspace 目录**（`data/general/workspace` + `data/workspaces/*/workspace`），仅此而已。执行时动态解析（新建 ws 自动纳入）。
- 三个域**排除在外**，留在沙箱 deny 侧（默认 `(deny file-read* DATA_DIR)` 不放行即成）：
  - `db.sqlite`（身份域——任务读写 DB 是灾难面）
  - `knowledge/`（学习域——蒸馏白名单守门被绕过=击穿隐私防线）
  - 各 ws `pi-sessions/`（历史域——含其它成员对话，跨读违反会话私有红线）
- `scheduled_tasks.workspaceId` 对 system 恒 null（M4 原语义保留）。

### 2. 越界原则：专属 extension 受控通道，不放宽沙箱

未来任务需触达工作产物域之外的域时，**不是**把目录加进沙箱白名单，而是写专属 extension 工具（服务端代理：按权限过滤后喂给 pi）。先例=bridge RPC（loopback+nonce+服务端权限闸）。文件沙箱=唯一粗边界；extension=细粒度越域的唯一通道。

### 3. 权限开关（任务级最小权限）

- `allowWrite`（缺省开）：false=全部 ws 目录进 ro（沙箱全盘禁写下唯一可写=sessionDir——/tmp 也不可写，UI 须明示「无法写任何文件，产出仅执行日志」）。
- `allowSearch`（缺省关）：工具层权限（不加载 tavily 扩展=LLM 无搜索工具），非网络层——pi 必须连 LLM provider，禁网物理不可能；越狱 bash 出站是 Seatbelt 已知局限（网络级收窄待 #22 netns）。

### 4. 修订 ADR-0021 决策 7

「system 任务只读、admin 经 UI 停/启/删」→「**admin 经 UI 全管理**（新建/修改含权限开关；删除须无在跑 run，409 口径与手动跑一致）；**LLM 工具侧（bridge /task/*）维持只读语义**」。system 任务执行分叉：蒸馏 seed（固定 id 特判，冻结，仅 cron 可改）与通用 headless（本 ADR 权限模型）——不引入 kind 字段，rule of three。

## 后果

- 巡检/汇总类任务天然跨 ws 触达工作产物；身份/学习/历史三域对任务 pi 不可见。
- extension 成为新的受控面（每个越域能力一个，须自带服务端权限过滤）——v1 零个，按需增。
- 蒸馏链行为与 M5 验收完全一致（特判分支不读新列）。
