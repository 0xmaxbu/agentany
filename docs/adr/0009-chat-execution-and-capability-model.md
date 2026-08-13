# chat 界面：会话驱动的执行与能力模型

chat 界面是 agentany 的**主产品面**（非技术内部用户在此对话、上传资料、触发能力；Pi 唯一引擎）。本 ADR 把 chat 的执行、能力、记忆与恢复模型钉死，作为实现根。经 `/grill-with-docs` 两轮 grilling（Q1–Q12）得出。

前置：ADR-0001（Pi 唯一引擎）、0003（Hono 单进程 + SSE/WS）、0005（skill 全量自动发现、extension 显式 `-e`）、0006（项目隔离）、0007（工作流引擎 step-boundary + append-only log + 挂起/续跑）、0008（执行=工作流运行|对话，统一过程/反馈/学习）。

## 决策（Q1–Q9）

**切片范围（Q1）**：第一片 = **全栈薄切片**：一条 SSE 流式自由对话（文本进/token 出/跨轮记忆）+ 极简 React 聊天页。**实施后端先行**（先定 SSE 契约、curl 验通流式+session，再让 React 消费）。**不含**能力触发/HITL/上传（后续切片）。

**会话 ↔ Pi session（Q2）**：**1 会话(Conversation) = 1 持久 Pi session**。sessionId 确定性派生 `chat-<conversationId>`，session-dir 落 `data/projects/<projectId>/pi-sessions/`。跨轮复用、Pi 自带记忆；重开会话=换 conversationId。与 workflow run 同模式（`run-<runId>`）。**记忆/压缩/恢复见下专节。**

**流式 runPi（Q3）**：**双模式同 spawn**。加 `runPiStream({...,onDelta})` 把 `text_delta` 边到边外吐给 chat SSE；workflow 步继续用缓冲版 runPi（要完整结果，已验稳）。复用 `buildArgs` + 手写 LF reader。

**v1 身份 & 项目（Q4）**：dev **单用户桩**（扩 auth-stub）+ 单 **temp/dev 项目**（复用现有占位 projectId）。`conversations` 表带 `userId/projectId` 列就位，真 auth/projects 上线不返工。

**能力模型（Q5）**：触发走**对话 NL 自动发现**，不靠点菜单。skill 由 pi 自动发现（ADR-0005）；工作流同走 NL 自动发现（见 Q6）。**基础通用工具默认开启**（每个 chat turn 的 runPi 默认 `-e` 这类扩展，如 `tavily-search/web-search`）；其余工具型 skill（document-tools、convert-documents-to-markdown）走自动发现、pi 按需用。**方法论型 skill（brand-research / brand-strategy-analysis）不独立触发**——是各自工作流内部深度指引。菜单 = **管理面**（查看/配置可用能力），非触发入口。

**工作流 NL 自动发现（Q6=A）**：**pi 桥接工具**。给 pi 注册 `start_workflow(id, input)` / `resume_workflow(runId, data)`，工具描述列可用工作流 + inputSchema。pi 读对话 NL 自己判断调哪个、从 NL 抽参填 inputSchema——与 skill 自动发现**同一机制、pi 当唯一决策者**。工具处理程序薄桥到服务端（pi 子进程 → localhost HTTP → 引擎）；工作流执行/HITL/状态仍在服务端（ADR-0007）。

**HITL 经 tool-call 的 suspend/resume（Q7=A+X）**：
- **pi 用 NL 中介**：工具返 `{stepId, payload, resumeSchema}` 给 pi → pi 向用户提问 → 用户回 → pi 填 resumeSchema 调 `resume_workflow`。resumeSchema 极简（`selected`/`decision` + 可选 comments），NL 填零压力；填错由服务端 `validate()` 拒、pi 重试。
- **交互工具**：chat 界面给 pi 供 `ask_user({prompt, options[], select:"single"|"multi"})`，在 chat 渲染单/多选 UI；用户选 → 工具返选择 → pi 用之（如填 resumeSchema）。**后期加更多交互工具**。
- **长 agent 步异步（X）**：工具立即返 `{status:"running", stepId}`，run 服务端续跑、SSE 把 run-log 流进 chat；下一个 suspend/完成**触发新一轮 pi turn** 中介。engine 在每个 step 边界交还控制权，与 ADR-0007 step-boundary 吻合。**嵌套 pi** 是自然结果（chat-pi →桥接→ 引擎 agent 步再起一个 pi），各自独立 session。

**管理菜单 v1（Q8=a）**：**只读列表**。列 skills（name+description+类型[工具/方法论]）+ workflows（id+name+description+inputSchema）。启停/编辑后续配合 auth。

**上传资料（Q9=a）**：上传进会话所属项目工作区 `data/projects/<projectId>/workspace/uploads/`，消息存附件引用。pi cwd 已是工作区 → agent **零额外接线**能读、触发的工作流同 cwd 直接消费。切片 2+。

## 记忆分层、压缩与会话恢复（Q2 深化 / Q6 / Q10–Q12）

**Pi 内置压缩，我们不造**（evidence：Pi v0.83.0 `dist/core/compaction/` + `docs/compaction.md`，置信度 HIGH）：auto-compaction 是一等公民——**主动**（`contextTokens > contextWindow − reserveTokens`，`agent_end` 后；`agent-session.js:1485-1560`）+ **反应**（provider overflow → 删失败 msg → 压缩 → 重试一次；二次才报错停）。机制：保留最近 `keepRecentTokens`(默认 20k)、更老的用结构化模板（Goal/Constraints/Progress/Decisions/Next/Critical Context）摘要、追加自包含 `CompactionEntry`(summary + firstKeptEntryId + retainedTail)、**累积式**；tool-result 在摘要 prompt 里截到 2000 字符（原文仍在盘）。配置在 `<project>/.pi/settings.json` 或 `~/.pi/agent/settings.json`：`compaction.{enabled, reserveTokens:16384, keepRecentTokens:20000}`、`branchSummary.*`（**无 env**）；扩展钩子 `session_before_compact` 可取消/换模型自定义。`/compact` 手动仅交互模式 → 我们 `-p` 只靠 auto。→ **Q2「压缩/保存」溶解**：Pi 已办，我们只补**归档**（留原始 jsonl）+ **提 learning**（ADR-0008）。

**memory 四层**：

| 层 | 内容 | 隔离 |
|---|---|---|
| L1 会话 transcript | pi `.jsonl`（含 compaction 检查点） | session-id（会话内） |
| L2 项目上下文 | cwd 的 `AGENTS.md`/`CLAUDE.md`（pi 每轮自动加载，`-nc` 关；`resource-loader.js:31-107`） | 项目（cwd） |
| L3 能力+经验 | repo `skills/*/SKILL.md` + `experience.md`（ADR-0008） | repo 级（⚠ 跨项目共享） |
| L4 应用对话 | DB `conversations/messages` + run log | projectId |

**L3 隔离（Q10=a）**：v1 维持 repo 级共享；**规则：经验提取 job 只泛化通用经验、客户专属事实不进 skill**（客户产出留在项目工作区/DB）。多真客户落地时再做 per-project experience 叠加。

**会话恢复 / 重挂（Q6 + Q11=a）**：run 状态在**我们 DB**（ADR-0007：append-only、跨进程 resume、幂等），**pi-session 是有损、可重建的中介**，不是真相源。**每轮 `--append-system-prompt` 注入"本会话挂起的 run（runId/stepId/resumeSchema）"**——压缩把 runId 摘掉、pi 忘了，或 session 文件丢失，都能重挂。pi session 文件本身鲁棒（`session-manager.js:617-640`：删→`--session-id` 自建空、空→自愈写 header、损→报错不改文件、list 单文件损不阻塞）。`session_before_compact` 钩子（保活跃 run 进摘要 Critical Context）**defer**——v1 每轮重注入即 belt-and-suspenders。

**项目持久记忆（Q12=a+b）**：服务端维护项目工作区 `AGENTS.md`（项目/品牌背景、关键决策；可与"挂起 run"摘要合并表达）→ pi 每轮自动加载（L2），给 pi **稳定项目记忆、抗压缩丢失**，对"非技术用户多次回访同一项目"是质变。每项目 `.pi/settings.json` 留 `compaction.*` 旋钮、默认值起步。

**待实测（切片②）**：auto-compaction 在 `-p` 跨轮持久 session 下确实触发（跑长对话、观察 jsonl 里出现 `compaction` 检查点）。

## 切片①后端实现约定（grilling 第三轮 + FE2）

**路由形态（BE-Q1=a）**：`POST /conversations/:id/messages` **直接返 SSE**（请求即流：pi 回复 token 实时回流；客户端 fetch+读 body 流，per-msg 自包含）。`GET /conversations/:id/messages` 返历史（JSON）。slice①无持久 SSE——slice②要服务端主动推（run 进度）时再加。

**并发 = per-conversation FIFO 队列（BE-Q2=b / Q8=a / Q9=a）**：每会话一条**内存** FIFO 作业队列（`Map<conversationId, Job[]>`，单进程无需 Redis），不同会话可并发；串行保护 pi session 不被并发写。排队中的消息其 POST SSE **静默等待（心跳保活）到轮到它再吐 token**（Q1=a 下唯一保流式自洽形态）。每会话 pending 上限 5、超出 reject 429；作业失败只写该作业 `error` + 不 poison 队列、照常推进下一条；进程重启内存队列丢、未跑 queued 消息不补（已知缺口、文档记）。

**runPiStream（BE-Q3）**：抽共享 `spawnPiCore(opts, handlers)`，`runPi`/`runPiStream` 两薄壳；`runPiStream(opts, onDelta: (text)=>void): Promise<RunPiResult>`（镜像 runPi、仅多 onDelta）。workflow 步继续缓冲版 runPi。每轮 prompt = **仅新用户消息**（pi session `chat-<conversationId>` 持历史、重载 transcript，不重喂）。

**SSE wire format（BE-Q4 + FE2）**：**单通道 JSON-`type` 判别**——一条 SSE event，data 是 JSON 带 `type`：`delta`/`done`/`error`（slice①），后续 `hitl_request`/`run_progress` 零改协议加入。15s `:heartbeat` 注释防代理超时。

**取消（FE2）**：`POST /conversations/:id/abort` 服务端杀 pi 子进程 + 出队当前作业 + 写 error/done 收尾帧（服务端拥有 pi，客户端 AbortController 不够）。

**客户端传输（FE2）**：fetch + ReadableStream（**非 EventSource**——要带 auth header、且 POST）。~40 行包装（参考 chatbot-ui `consumeReadableStream`）。

**持久化（BE-Q5）**：助手回复流给前端、**turn 结束一次性写 DB**（内存攒全文，agent_end 后写一行 assistant message）。

**测试 DI（BE-Q6）**：`RunDeps` 加 `runPiStreamFactory?`，测试注 stub 吐确定性 delta。

前端借模式清单见 `docs/chat-frontend-borrowed-patterns.md`（实现期随时查 + 标已采纳）。

### 切片①后端实现落定（用户已认 2026-08-12）

**3 个小决定（推荐采纳）**：
1. **slice① 纯文本对话**——不默认开 `-e` web 工具（Q5"基础工具默认开"推迟到 slice② 桥接一起上，那时 `-e` 本就要接）。隔离流式/排队管道。
2. **chat 的持久化方法挂 `WorkflowStore`**（已是 db 门面，同 feedback 模式）；重命名 → `Store` 留清理。
3. **abort 只杀当前在跑的 turn**（排队中的作业不删，KISS）；出队排队项留 refinement。

**文件清单**：
- 新：`src/chat/queue.ts`（`ConversationQueues`：per-conv FIFO chain + pending cap 5 + `abort` 杀当前 turn 的 AbortController）、`src/chat/turn.ts`（`runTurn`：runPiStream→攒全文→干净结束写助手消息发 `done`；aborted 发 `done.aborted=true` 不写消息；抛错发 `error`）、`src/routes/conversations.ts`（4 端点 + POST 即 SSE + 15s `: ping` 心跳）、`test/chat.backend.test.ts`、`drizzle/0002_<auto>.sql`。
- 改：`db/schema.ts`（+`conversations`/`messages`）、`workflow-engine/store.ts`（+chat 四方法）、`pi/runPi.ts`（抽 `spawnPiCore(opts,{onDelta})`，`runPi`/`runPiStream` 两薄壳，都过 h9 信号量）、`pi/runPi-factory.ts`（+`makeRunPiStream`）、`runs.ts`（`RunDeps` += `runPiStreamFactory?` + `ConversationNotFound`/`QueueFull`）、`app.ts`（挂 conversation 路由）。

**API**：`POST /conversations`→201；`GET /conversations/:id`；`GET /conversations/:id/messages`→历史 JSON；`POST /conversations/:id/messages`→`text/event-stream`（`{type:delta|done|error|heartbeat}`，用户消息 POST 即落库、助手消息 turn 结束一次性落库）；`POST /conversations/:id/abort`。

> **slice② 线协议修订（#13 起，2026-08）**：`POST /conversations/:id/messages` 不再返流 → 返 **202 ACK + 投 EventBus**；客户端改经 **`GET /conversations/:id/stream`**（持久 SSE，订阅 EventBus）收所有帧。**原因**：slice② 帧多源——用户 turn、`run_*` 事件 turn（#15）、`hitl_request`（#16 bridge /ask_user）、`hitl_answered`（#18 /approvals）——这些帧生在任何 POST turn **之外**，单条 POST→流到不了客户端；持久流 + EventBus 是多源扇出的唯一通路。上 slice① 的 `POST→SSE` 契约**被此取代**（关键不变量①-⑥仍成立，仅投递通道变）。`429` 由 `wouldAcceptHttpTurn` 同步预检（#13）。

**DB**：`conversations(id,projectId,userId,title?,createdAt,updatedAt)` + `messages(id,conversationId FK,role,content,attachments?,createdAt)`。

**关键不变量（测试钉）**：① 同会话 turn 严格串行（FIFO）；② 跨会话并行；③ abort→流以 `done.aborted=true` 收尾且不写助手消息；④ pending>5→429；⑤ 全文 = delta 拼接；⑥ 用户消息立即落库、助手消息 turn 结束落库。Hono：`streamSSE(c,cb)` 须传 `c`；所有 stream 写串一条 promise 链（防心跳注释插帧）。

## 备选（grilling 已否决）

- **Q5 旧"能力=统一菜单入口"**：否。CONTEXT 原定义"能力=工作流/skill 统一概念、用户不区分"已**作废**——改为 NL 自动发现触发 + 管理菜单分离。
- **Q6 (B) 服务端路由器分类 NL→工作流**：否。多一跳 LLM，且把 skill 发现（pi 内）与工作流发现（服务端）分裂两套机制；选 (A) 统一由 pi 决策。
- **Q7 (B) run 脱离 + 结构化卡片绕过 pi**：否。pi 对话记忆与服务端 run 生命周期脱节、反向同步复杂；选 (A) pi 自驱动、上下文天然一致。
- **Q7 (Z) 同步阻塞 tool-call**：否。把 run 执行绑 pi turn/连接寿命，长 agent 步下脆；选 (X) 服务端拥有 run、chat 是其窗。
- **Q9 (b) 独立对象存储**：否。引外部依赖；选 (a) 落项目工作区、pi 直接读。
- **Q10 现在上 per-project experience**：否。v1 单 temp 项目，跨项目泄漏此刻不成立，属过度设计；选 repo 级共享 + 提取规则兜底。
- **Q11 (b) `get_pending_runs` pi 工具**：否（v1）。靠 pi 自觉调、易漏；选每轮 `--append-system-prompt` 注入（幂等、零往返）。
- **Q12 现在上 `session_before_compact` 钩子**：否。每轮重注入已足；钩子留 token 优化期。

## 后果

- **新表**：`conversations`（id, projectId, userId, piSessionId, createdAt…）+ `messages`（id, conversationId, role, content, attachments?, createdAt）。`workflow_runs` 加 `conversationId?`（run 可挂在会话下）。反馈多态 `targetKind="chat"` 已就绪（ADR-0008，零改）。
- **新件**：`runPiStream`（流式版）；chat SSE 端点（订阅会话 + tail run-log）；pi 扩展：`start_workflow`/`resume_workflow`/`ask_user`（及后期更多交互工具）；**每轮 `--append-system-prompt` 注入挂起 run**；**项目 AGENTS.md writer**；每项目 `.pi/settings.json`（compaction 旋钮）。
- conversations 驱动 pi session（`chat-<conversationId>`）；run 仍 `run-<runId>`。chat-pi 与工作流 agent 步 pi **独立 session**。
- **记忆四层**（L1 transcript / L2 AGENTS.md / L3 skills+experience / L4 DB）各按其隔离边界；压缩 Pi 自管、我们只归档+提 learning。
- 长会话 pi-session 膨胀由 Pi auto-compaction 兜底；裁剪/保留期策略待定（ADR-0008 已记）。
- **切片顺序**：① 自由对话全栈薄切片 → ② 桥接工具 + 工作流 NL 触发 + HITL + ask_user + **每轮注入挂起 run + 项目 AGENTS.md + 长对话实测 compaction** → ③ 上传资料 → ④ 管理菜单（只读）→ ⑤ 真 auth + 启停/编辑。

## 关联

ADR-0001（Pi 唯一引擎）、0003（传输）、0005（skill/extension 加载）、0006（项目隔离）、0007（工作流引擎）、0008（执行/反馈/学习闭环）。
