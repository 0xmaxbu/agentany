# 文档基础能力（document-tools）

读 PDF/DOCX、PDF↔DOCX 互转的 agent 基础能力。详见 `skills/document-tools/SKILL.md`。

| 能力 | 工具 | 命令 |
|------|------|------|
| 读任意文档 | anydoc | `npx -y @firecrawl/anydoc <file>` |
| 读/编辑 DOCX | OfficeCLI | `officecli view <file> text\|html` |
| DOCX→PDF | docx2pdf（自封装） | `bash tools/docx2pdf/run.sh <in.docx> <out.pdf>` |
| PDF→DOCX | pdf2docx（自封装） | `bash tools/pdf2docx/run.sh <in.pdf> <out.docx>` |

# 品牌战略升级（brand-research + brand-strategy-analysis）

两个 coded 工作流（Pi 驱动）：
- **brand-research**（调研，全自动）：品牌+地区（缺省全国）→ Tavily 五块深度调研 → 3-5 个经逻辑验证的切入角度。不满意带 `focus` 重跑。
- **brand-strategy-analysis**（战略分析，HITL）：读调研产出 → 用户选角度 → 生成战略升级报告（严守**红线**：不涉具体设计样式）→ 验收（可 revise 循环）。

- 定义（coded，源真相）：`apps/server/src/workflows/{brand-research,brand-strategy-analysis}.ts`
- 规格（衍生物）：`workflows/{brand-research,brand-strategy-analysis}.md`
- 方法论 skill：`skills/{brand-research,brand-strategy-analysis}/SKILL.md`
- 搜索能力（可复用）：`skills/tavily-search/`（`web_search`/`web_extract`/`web_crawl`）
- key：`.env` 的 `TAVILY_PROXY_API_KEY`

## 术语表

| 术语 | 含义 |
|------|------|
| Pi | [earendil-works/pi](https://github.com/earendil-works/pi) 的 AI agent toolkit，本项目的执行引擎（编码 agent CLI，本机全局安装 v0.83.0） |
| 工作流 (Workflow) | 一个**结构化、可程序化调用、可被其它工作流调用**的流程，有明确输入/输出，可中途**挂起等待人机交互**（如「用户选角度」）。在聊天界面里作为一个「能力」暴露给用户。它含两个不同概念——见下「工作流定义」与「工作流运行」 |
| 工作流定义 (Workflow Definition) | 工作流**「是什么」**：它的步骤、输入/输出契约、所需能力、允许的角色。一个定义可被**多次运行**（不变）。 |
| 工作流运行 (Workflow Run) | 工作流**「跑了一回」**的具体实例：带输入、每步产出、状态（运行中/挂起/完成/失败）。HITL 工作流的一次运行可中途**挂起**、等人输入后**续跑**（甚至跨进程）。 |
| 全自动工作流 vs HITL 工作流 | 工作流按是否需人介入分两种：**全自动**的跑到底、人工只验收（不足可定向重跑，如「调研」）；**HITL**的中途挂起等人输入再续（如「战略升级分析」选角度）。决定一个工作流能否被无门程序化触发（如「新建项目」自动跑调研） |
| 运行简报 (Run Brief) | 工作流运行的**终态产出物**（≤200 字符契约，首句直说结果，产物路径可点预览）：run 完成/失败时引擎确定性直投为会话消息，不经 LLM 转述。末步产出 `brief` 字段，缺省兜底为步骤列表摘要（ADR-0025）。 |
| 角色 (Role) | 用户的**功能身份**（v1：admin | member 单值）。admin 管用户/workspace；**可见性不由角色控制**——workspace 访问看名单/allUsers，会话看创建者（ADR-0018）。 |
| 执行 (Execution) | 一次 agent 调用（**工作流运行** or **对话**），有过程、可收反馈、可被提取经验。工作流运行和对话都是「执行」的形态（ADR-0008）。 |
| 反馈 (Feedback) | 用户对一次「执行」的评价/批注（文本 + 可选评分），是经验提取的原料。**多态挂载**（`message` / `workflow_run` / `chat`，同表同接口；行带作者 authorId，回显按人过滤）。 |
| 经验提取 (Experience Extraction) | 从「执行过程（pi session）+ 反馈」蒸馏可复用经验 → 直写对应 skill 的 `experience.md`（agent 即时受益）+ `learnings/` 审计（ADR-0008，后期定时 LLM 任务）。 |
| 经验文档 (learning) | 一次运行后沉淀的结论/教训，带证据和适用场景。见 `learnings/` |
| Skill | 成熟的经验固化为 agent 可直接调用的能力（SKILL.md）。见 `skills/` |
| 能力 (Capability) | chat 里可用的一个动作（工作流或工具型 skill）。**触发走对话 NL 自动发现**——用户在对话里说，系统自动匹配并触发，不靠点菜单；**菜单里的工作流/skill 列表是管理面**（查看/配置可用能力），非触发入口。基础通用工具（如搜索）默认开启。方法论型 skill 是各自工作流的内部深度指引，不独立触发 |
| 工作空间 (Workspace) | **可访问目录 + 权限控制的唯一原子单位**（ADR-0018）：一个服务器目录（工作区+pi session）配一份权限（`allUsers` 全员布尔 ∪ 可访问名单）。无类型之分——公司级/团队级只是名单范围差异。默认存在全员可访的公司 workspace（`ws_company`）。仅 admin 可建/可管。会话与工作流运行都挂 workspace；run 可见性随 workspace 权限。 |
| System Workspace（逻辑概念） | **项目全部域**——system 定时任务的执行范围。非实体 workspace 行（不占 ws 表、无名单/权限）：执行时沙箱白名单动态=全部 workspace 的工作区目录（新建 ws 自动纳入）。与之相对，实体 Workspace 是最小权限锚点（单域）；System Workspace 是 admin 信任边界下的全域（#38）。**越界原则**：需触达 workspace 目录之外的域（DB / knowledge / pi-sessions 等），一律经专属 extension 受控通道（服务端按权限过滤），不放宽文件沙箱（ADR-0023）。 |
| System 任务 (System Task) | 无人值守定时任务（scope=system）：无产出会话、无交互（无 bridge），产出=task_runs 日志。分两种命运——蒸馏（内置 seed，全局单例，特判链，仅可改 cron）与通用 headless（admin 经 UI 建/改，权限开关 allowWrite/allowSearch 收敛，#38）。 |
| 项目 (Project) | **逻辑概念**（非系统实体）：一次客户/品牌 engagement 的通称。系统里以 workspace 承载（如为 engagement `acme` 建 ws）；曾试实体化（ADR-0013/0014），被 ADR-0018 废除——作用域归 workspace，组织归属不进权限链。 |
| 会话 (Conversation) | 一条聊天线索，挂在 workspace 上（缺省公司 workspace）；**一律创建者私有**（+admin）——对话隐私与 workspace 权限是正交维度。用户在其中对话、上传资料、触发「能力」 |
| 资料 (Materials) | 用户在会话中上传的文件，落入该会话 workspace 的服务器工作区；可被 agent 当上下文读、喂给触发的「能力」、或用文档工具加工 |
| 用户 (User) | 内部团队成员（设计师、客户经理等）。每人一个账号（用户名+密码），由管理员开通/注销；不接 SSO |
| Pi 会话 (Pi session) | Pi 自己的跨轮记忆文件（`--session-id`+`--session-dir` 存盘），按 sessionId 定位。**不同于「会话(Conversation)」**——一个 Conversation 确定性派生一个 Pi session（`chat-<conversationId>`），但 Pi session 是技术物件、Conversation 是产品概念。工作流运行也各派生一个（`run-<runId>`）。 |
| 块 (Block) | 消息内容的原子单位（ADR-0019）：一条消息 = blocks 序列，四件套 `text`/`thinking`/`tool_use`/`tool_result`。历史（pi session 读取）与实时（SSE 三帧）同构——同一 Block 形状、同一渲染组件。前端消息模型的单一真相（取代旧「纯文本 content」）。 |
| 块三帧 (Block frames) | 实时块流的三种 SSE 帧（ADR-0019）：`block_start`（含 kind/meta）、`block_delta`（增量）、`block_end`（关块）。blockId 标识**块**；turn 边界仍由 `done` 帧表达（块边界 ≠ turn 边界）。legacy `delta` 帧已删（双发收口）。 |
| 轮 (Turn) | 与系统的**一次完整交互**：一次输入 → 一次产出。输入双源（用户输入 / 系统消息）× 处理双径（LLM / 确定性），一次输入恰为一轮。系统的核心价值在**产出**而非输入——产出物是一等协议公民（ADR-0025）。 |
| 系统消息 (System Message) | **输入方是系统**的消息（run 事件、cron 触发）。不是「没有输入」，而是系统作为对话参与方发起的轮（ADR-0025）。 |
| 事实事件 (Durable event) | 落投递日志、可重放的事件（消息定稿/简报/卡/run 状态）。重放按投影等价重建（ADR-0026）。 |
| 瞬态帧 (Transient frame) | 传输细节（`block_delta` token 增量）：内存直推、永不落日志，重放以整块合成。IM 等通道只消费事实事件、不收 token 流（ADR-0026）。 |
| 归档会话 (Archived conversation) | 从主列表移除但**可查可恢复**的会话（ADR-0020，archivedAt 软态）：历史只读、禁止发消息；创建者可归档/恢复，删除（不可逆全链清理）仅 admin。区别于「删除」——归档是整理，删除是清除。 |
| 归档 Workspace (Archived workspace) | admin 的整理动作（#手风琴）：workspace 从所有用户侧栏隐藏，但**其会话可看可发**（非封禁——区别于归档会话的只读）；admin 可恢复；公司 workspace 不可归档。 |
| chat 界面 (Chat surface) | agentany 的主产品面：用户在此对话、上传资料、触发能力。闲聊流式走 SSE（ADR-0003），单进程 Hono + React/Vite 托管。 |
| 基础通用工具 (Basic universal tool) | 每个 chat turn 默认开启的工具扩展（如搜索 `tavily-search/web-search`），无需用户/工作流显式声明。其余工具型 skill 走自动发现、pi 按需用。 |
| 自动发现 (Auto-discovery) | pi 的标准能力发现：每次运行自动扫全部 repo skills（ADR-0005），模型按需调用。工作流经**桥接工具**同样被 pi 自动发现、从 NL 触发（ADR-0009）。 |
| 桥接工具 (Bridge tool) | 注册给 pi 的工具（`start_workflow`/`resume_workflow`），让 pi 在对话里从 NL 触发/续跑服务端工作流。薄桥：pi 子进程 → localhost HTTP → 工作流引擎（ADR-0009）。 |
| 交互工具 (Interaction tool) | chat 的**通用提问工具** `ask_user`，双源（ADR-0025）：**自主提问**（LLM 不确定时自己调，不绑 run，答案经 pi 归一化）与**强制提问**（run 挂起时引擎据挂起契约直建卡，enum 对位由代码保证）。客户端统一渲染选择卡，不问出处。 |
| 项目记忆 (Project memory) | workspace 工作区的 `AGENTS.md`（L2）——pi 每轮自动加载，承载 engagement/品牌背景与关键决策，给 pi 稳定的**workspace 级持久记忆**、抗会话压缩丢失。不同于会话 transcript（L1，会话内）与 skill 经验（L3，repo 级）。 |
| 系统 (System) | 承载**全局、跨项目配置**（安全姿态 `SECURITY_POSTURE`、运行参数、全局开关等）的实体；对所有项目/会话生效，与「项目级」配置对立。是独立实体、非范围限定词（ADR-0013）。 |
| 系统作用域 (System scope) | **服务端代码装配跨 workspace 数据的权限**（非 pi 的读写特权）：跨 ws 数据（如蒸馏要读的各 ws pi session）由服务端装配成最小切片供任务 pi 只读；pi 全程无跨 ws 读写能力（ADR-0021）。不是 workspace——无名单/权限语义，是正交的全局维度。 |
| 定时任务 (Scheduled Task) | 用户配置的 **cron 触发器**，**仅触发 LLM 可独立完成的任务**（**不触发工作流**——工作流含 HITL/审批语义，cron 无人值守不适用）。**任务本质=自由 prompt 任务**：用户在 chat 里说需求（如「每 4 小时去 xx 网站读新闻发摘要」），LLM 解析出 cron+任务 prompt+**display_name**（任务名）→ **任务卡确认**（cron 人类可读+未来 3 次执行时间+频率下限校验）→ 入库；到点=pi 以该 prompt 跑（chat 同构沙箱但**无 bridge**——无人值守无交互语义，tavily 保留），产出投递**产出会话**。两类 scope：**workspace**（成员随口建，绑建时 ws+产出会话）/ **system**（跨 ws 内置如经验蒸馏，seed DB 行，**无产出会话**——产出=执行日志在管理页看，带**未读数**、点开即清；**经 chat 删除/停用一律服务端硬拒**，仅 admin UI 可管）。**成员自建自批**（任务卡自己确认即建；CommandPolicy 仅 deny 拒——require_approval 同样自建自批、任务卡确认即批，不发 admin 卡）；**system 任务经 chat 工具只读且仅 admin 可读，删/停/改一律工具层直接拒**（管理只走 admin UI）；对话/面板可改可管自己的任务；执行不再逐次问；支持手动调用（trigger 区分 cron/manual）；错过窗口记 missed 不补跑；同任务在跑→跳过（skipped_overrun）。**产出文件**：执行器从 blocks 流的 tool_use 记录收集被写文件→task_files 登记→产出会话渲染文件管理器式列表，`GET /files/<workspaceId>/<relative_path>` 预览（登录+ws 访问权；v1 纯文本预览 md/txt/html/pdf，预览页顶部下载按钮；无预览能力的扩展名直接下载）。 |
| 产出会话 (Output conversation) | **workspace 定时任务**创建时自动建的专属会话（挂任务同 ws，标题=display_name）：任务每次执行的产出投递于此。system 任务无产出会话。创建者=建任务的用户。 |
| IM 通道 (IM channel) | Web/App 之外的即时通讯通道，接入 chat 的 pending 卡决策（v1 飞书，钉钉同接缝第二批；ADR-0028）。**一应用一条长连接服务全租户**（飞书集群模式，非 per-user）；出站是 REST 短连——多用户无连接数性能障碍，瓶颈在平台 API 限频。 |
| IM 决策入口 (IM decision entry) | IM 上回答 pending 卡的通道并集：**按钮作答**与**文本作答**两条，都收敛到同一张卡的 CAS（响应只处理一次）。 |
| 按钮作答 (Button answer) | IM 的**确定性通道**：卡片选项渲染成按钮，`card.action.trigger` 回调携带 questionId+值 → 直接 dispatch/CAS，零 LLM。approval/task 由此在 IM 上决策（重开 #49 决策 5，ADR-0028）；文本仍不放行这两种卡。 |
| 文本作答 (Text answer) | IM 的**归一化通道**：用户打字 → LLM 按 resumeSchema 归一化判答。仅对 kind=ask 卡生效；多张候选并存时走**选择卡**收口。 |
| 选择卡 (Selection card) | **多卡歧义收口**：用户文本无法判断答哪张 pending 卡时，bot 发一张系统卡列出各候选（仅 prompt）追问目标，点击后用缓存的待确认文本判答。不归任一工作流会话——只回答「答哪张」。 |
| 绑定码 (Bind code) | 用户自助绑定 IM 的凭证：Web 已登录用户点「绑定 IM」生成 **10 分钟有效、单次使用**的高熵码，到 IM 发 `#bind <码>` → 把该 IM 身份（如飞书 open_id）绑到自己的 agentany 账号。推翻 #49 决策 6 的 admin 静态绑定（ADR-0028）。 |
| 绑定补发 (Bind backfill) | 绑定成功的瞬间，把该用户全部存量 pending 卡各补发一次通知+卡——用户最该看见历史积压的时刻。仅绑定时刻触发，不做启动扫描（防重启风暴）。 |
| 回执 (Receipt) | IM 上对一次决策/绑定的即时反馈文本，一律来自输出方状态判读、不假装成功：成功「已处理：<内容>」/ 幂等「该卡已被处理」/ 归一化失败「无法据此推进，请重试或点选」/ 绑定成功「已完成，N 张待办」。 |
