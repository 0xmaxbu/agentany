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
| 角色 (Role) | 用户的功能身份（如「策略师」「管理员」），**决定能调用哪些工作流、能访问哪些项目**。一个用户可有多个角色；角色写在工作流定义上，鉴权在系统边缘执行（引擎本身不管鉴权）。 |
| 执行 (Execution) | 一次 agent 调用（**工作流运行** or **对话**），有过程、可收反馈、可被提取经验。工作流运行和对话都是「执行」的形态（ADR-0008）。 |
| 反馈 (Feedback) | 用户对一次「执行」的评价/批注（文本 + 可选评分），是经验提取的原料。**多态挂载**（`workflow_run` / `chat`，同表同接口）。 |
| 经验提取 (Experience Extraction) | 从「执行过程（pi session）+ 反馈」蒸馏可复用经验 → 直写对应 skill 的 `experience.md`（agent 即时受益）+ `learnings/` 审计（ADR-0008，后期定时 LLM 任务）。 |
| 经验文档 (learning) | 一次运行后沉淀的结论/教训，带证据和适用场景。见 `learnings/` |
| Skill | 成熟的经验固化为 agent 可直接调用的能力（SKILL.md）。见 `skills/` |
| 能力 (Capability) | chat 里可用的一个动作（工作流或工具型 skill）。**触发走对话 NL 自动发现**——用户在对话里说，系统自动匹配并触发，不靠点菜单；**菜单里的工作流/skill 列表是管理面**（查看/配置可用能力），非触发入口。基础通用工具（如搜索）默认开启。方法论型 skill 是各自工作流的内部深度指引，不独立触发 |
| 项目 (Project) | 一次客户/品牌 engagement 的工作空间。项目内的资料/报告/对话/产出**对其它项目不可见**，靠「用户↔项目成员关系」控制可见性 |
| 会话 (Conversation) | 项目内（或「临时」空间内）的一条聊天线索；用户在其中对话、上传资料、触发「能力」 |
| 资料 (Materials) | 用户在会话/项目中上传的文件，落入该项目的服务器工作区；可被 agent 当上下文读、喂给触发的「能力」、或用文档工具加工 |
| 用户 (User) | 内部团队成员（设计师、客户经理等）。每人一个账号（用户名+密码），由管理员开通/注销；不接 SSO |
| Pi 会话 (Pi session) | Pi 自己的跨轮记忆文件（`--session-id`+`--session-dir` 存盘），按 sessionId 定位。**不同于「会话(Conversation)」**——一个 Conversation 确定性派生一个 Pi session（`chat-<conversationId>`），但 Pi session 是技术物件、Conversation 是产品概念。工作流运行也各派生一个（`run-<runId>`）。 |
| chat 界面 (Chat surface) | agentany 的主产品面：用户在此对话、上传资料、触发能力。闲聊流式走 SSE（ADR-0003），单进程 Hono + React/Vite 托管。 |
| 基础通用工具 (Basic universal tool) | 每个 chat turn 默认开启的工具扩展（如搜索 `tavily-search/web-search`），无需用户/工作流显式声明。其余工具型 skill 走自动发现、pi 按需用。 |
| 自动发现 (Auto-discovery) | pi 的标准能力发现：每次运行自动扫全部 repo skills（ADR-0005），模型按需调用。工作流经**桥接工具**同样被 pi 自动发现、从 NL 触发（ADR-0009）。 |
| 桥接工具 (Bridge tool) | 注册给 pi 的工具（`start_workflow`/`resume_workflow`），让 pi 在对话里从 NL 触发/续跑服务端工作流。薄桥：pi 子进程 → localhost HTTP → 工作流引擎（ADR-0009）。 |
| 交互工具 (Interaction tool) | chat 界面提供给 pi、用于与用户交互的工具（v1：`ask_user` 单/多选；后期加更多）。pi 用它把 HITL 挂起/澄清等结构化提问渲染成 chat 里的选择 UI（ADR-0009）。 |
| 项目记忆 (Project memory) | 项目工作区的 `AGENTS.md`（L2）——pi 每轮自动加载，承载项目/品牌背景与关键决策，给 pi 稳定的**项目级持久记忆**、抗会话压缩丢失。不同于会话 transcript（L1，会话内）与 skill 经验（L3，repo 级）。 |
