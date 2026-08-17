# 0025 - run 生命周期零 LLM 直投：运行简报 + 强制提问 + ask 步契约

日期：2026-08-17（/grill-with-docs 会话定稿，Q1–Q15）

## 状态

已接受

## 背景

run 完成/失败/挂起的通知原本都走「TurnTrigger 起 LLM 事件 turn → pi 转述」：每轮全量历史 + 系统提示重注入，且事件 prompt 引导 pi 调 `read_run` 拉回**无截断的整份末步 output**（bridge-core 无任何封顶）——双份 token 浪费。挂起问句由 chat LLM 在事件 turn 里临时转写，enum 选项对位（ADR-0022 决策 4）只是君子协定，存在伪造/漂移路径；且 `ask_user` 实为挂起 run 专用工具（bridge 硬要求 runId + suspended），chat LLM 在无挂起 run 时反而没有结构化提问能力。

## 决策

0. **轮模型（2×2）**：轮 = 一次输入 → 一次产出，**限对话管道内的交互**（管道外执行——如 system 任务的 task_runs 日志——不构成轮）。输入双源（用户输入 / 系统消息）× 处理双径（LLM / 确定性），四象限皆有实例（卡片答案×确定性=hitl-dispatch；文本×LLM=chat turn；cron×LLM=任务投递）；本 ADR 补齐唯一未产品化的象限（**系统消息 × 确定性**）。**产出一等公民**：简报/卡/文件是系统产出物，不是 LLM 对话素材——LLM 转述即降格。产出到达必须驱动注意力（见决策 2 touch）。
1. **简报契约**：workflow 末步 output 带 `brief: string`（软预算 ≤200 字符，首句直说结果），旁挂 `artifacts?: string[]`（workspace 相对路径）。缺省/非 string/空 → 确定性兜底（步骤列表摘要）。零额外 LLM 调用（末步 pi 本就产文本，如 anglesSummary）。
2. **completed/failed 零 LLM 直投**：引擎从末步 output 提取 brief（failed 用 note）→ 写 `workflow_runs.brief` 列 + 发 role=assistant 消息（「📋 工作流 x 完成/失败：」前缀自标识，UI 零改造）+ **touchConversation（与 append 同事务）**（产出到达必须让会话在列表浮起——否则违反「产出是核心」；同事务归零窗口）。**不注入 pi 上下文**——用户追问时 pi 走 read_run 现查。
3. **崩溃封堵**：brief 列与终态落库**同 SQLite 事务**；`brief_message_id` 发消息后回填，启动对账扫未回填的终态 run 幂等补发。
4. **路径可点**：消息内仅对 `artifacts` 白名单**精确匹配**渲染链接 → 既有 `GET /files/:workspaceId/:path` inline 预览。零误命中、零新后端。
5. **ask 步（挂起契约收紧）**：挂起点收编为**独立 step**（`ask()` 工厂：question 固定串或代码拼装、**options 为显式映射 `[{label, value}]`——value 即 resumeData，点击=确定性派发**；无显式 options 时从 enum vals 派生（label=value，语法糖）；context 预渲染 markdown；resumed 时返回 `{...上游 input, answer}` 续默认链，可选 `route: (answer) => __next` 表达答案路由）。**显式映射是必要的而非锦上添花**：真实 HITL 主场景（brand-strategy 选角度）的 resumeSchema 是自由形 string（`"all"` 或 `"1,3,5"`）——无 enum，纯派生映射对其不成立，挂起零 LLM 会落空。**value 随卡落 DB（快照），前端只收获 label 不下行 value**——卡自包含（ADR-0022 价值），重启/改 workflow 定义不使旧 pending 卡映射失效。`SuspendSpec.payload` TS 类型收紧为 `{question, options?, context?}`（编译期强制；运行时缺失兜底降级文案；options 数与可映射值数一致在定义期断言）。ask 步**纯代码不调 pi**（保住无 pi 测试路径）；动态问句素材由上游 pi 步结构化产出。两段式挂起力学不变（ADR-0007）；`deterministicResumeData` 的 enum 分支保留兼容旧手写卡，新增显式 value 分支。
6. **强制提问**：run_suspended 时引擎**同事务**（挂起落库 + createQuestion 一个 SQLite 事务）直建卡——enum 按序对位由代码保证（`deterministicResumeData` 既有映射）。chat LLM 彻底失去建 run 绑定卡的权限，伪造路径物理消失。挂起卡持久恢复已有（GET /hitl），**无需伴生消息**。
7. **ask_user 双源通用化**：bridge `/ask_user` 去 runId/suspended 依赖 → **自主提问**（LLM 任何时候不确定即问；kind=ask、runId 空；答案落卡走 pi 归一化老路）。askHandler 分流：runId 空 = 纯落卡不 resume（防空引用）。
8. **read_run 保留 + 硬截断**：latestOutput stringify 截 8000 字符 + 「已截断，全文见 DB/文件」尾注。简报管面、read_run 管深。
9. **TurnTrigger 整类退役（职责内联）**：run 事件监听删除（run 事件不再驱动任何 turn）；**user_message → HTTP turn 入队内联进 POST 路由**（路由本就持有全部要素：`wouldAcceptHttpTurn` 同步 429 预检 + 幂等 attach 兜底语义随迁）——帧照发（前端显示用），turn 入队不再绕经 EventBus 订阅一跳。`queue.enqueueEventTurn` 保留（定时任务投递用）。三路统一叙事 =「**谁消费输入谁起轮**」，不是「一切经 EventBus」。**429 预检仅作用于将入队的 LLM 轮**——程序化轮（卡应答收口，不占队）永远接受、不入队：修订前的 429 预检会波及卡应答（队列满时连点卡都被拒），此净修复写入契约。路由重构同步段原则：append+touch+dispatch(同步 verdict) 前置于发布/入队，全同步 tick 内完成，异步全 detached。
10. **卡应答跳轮条件（收紧 + 落卡形态删除）**：跳过 LLM turn **仅当 run 绑定卡且点击命中可确定性映射的 value**（或重复点击且首次已派发——幂等 ack：消息照常落库、跳轮）。**无 run 绑定的 LLM 自主卡、以及点击未命中确定性映射（老手写卡无 value 无 enum）→ 不作卡处理、滑 LLM 轮**（卡保持 pending，`[待处理提问]` 注入仍在，pi 下轮判答归一化——错误方向安全）。**落卡形态整体删除**：旧 hitl-dispatch 的 `deterministicResumeData===undefined → markTaskCardDecided` 分支是缺陷（answered 后注入消失 + pi 不读 messages → resume 无人职守）；且对强制卡恒不可达（value 恒有）纯属死防御、对 LLM 自主卡是主动伤害。判定依据一句话：**答案的消费者是引擎（resume 副作用）则跳轮，是 pi（对话语义）则不跳**；卡=确定性收口，自由文本=LLM 归一化。
    - **修订（code-review 后，用户定稿）**：自主卡「滑 LLM 轮」原实现让卡**永久 pending**——但用户回答了问题，问题即 solved，卡该显示问题+用户回答。修订为：**自主卡回答即收口**——点选 → dispatch 确定性 `markQuestionAnswered`（answer=选项文本）+ **不跳轮**（消费者是 pi，对话继续）；打字 → pi 归一化后经新工具 `answer_question(questionId, answer)`（对应 run 绑定卡的 `resume_workflow`）落卡。跳轮判定不变（消费者是 pi 则不跳），变的是**回答必落卡**（悬置问题=状态谎言）。「老手写卡无 value 无 enum」子句已随旧路径清理一并退役（run 绑定卡恒带 values 快照）。
11. **resume 即时 verdict + detached 续跑**：`registry.resume` 现状 `await` 整个续跑全程（registry.ts:110）——卡应答 POST / bridge 工具调用会阻塞分钟级，与 start 的 fire-and-forget（registry.ts:73）不对称。拆分：同步段只做 schema/状态校验（rejected/idempotent 即时返回），续跑 detached——卡应答 202 ACK 与 bridge 工具结果即时返回，run 状态经 DB + 帧推流。
12. **复杂 schema 打字接力**：确定性收口失败 → 该输入滑入 LLM 轮路径归一化（一次输入恰为一轮，不 double count）。

## 负决策（防过度设计）

- 不建 SystemMessageHandlerRegistry 类——`publishOutcome` 内 switch 三分支 + 两个副作用函数；等第三种系统消息出现再抽象。
- 不建通用「产出物 Artifact」模型——现在只有 run 简报一种消息型产出。
- 简报不走引擎蒸馏 LLM（每 run 多一跳）也不走轻量转述 turn（仍付整轮历史）。
- 简报作者不用 system role——assistant + 前缀自标识，UI 零改造。

## 修订

- **ADR-0009 Q7(X)**：「下一个 suspend/完成**触发新一轮 pi turn** 中介」条款**废止**——run 三终态均零 LLM 直投（本 ADR 决策 2/6）。ask_user 从「HITL 挂起渲染工具」改为通用双源提问工具（决策 7）。事件 turn 仅存定时任务投递（系统消息 × LLM 象限）。
- **ADR-0022 决策 4**：enum 对位从「工作流作者按序给标签」的君子协定升格为**引擎代码强制**（本 ADR 决策 6）。

## 已知残余（接受）

- pi session 压缩丢 runId 时用户说「重跑刚才的」→ pi 无记忆；read_run 单查覆盖大多数场景，list-runs 工具留未来。
- run 卡刷新不恢复（无 GET runs 端点）——与 #19 序列号债务同堆，由 ADR-0026 P2 清偿。
- 简报直投需新整条消息帧形态（block_start/delta/end 三帧合成——`block_delta` 是文本块唯一内容载体，缺则空泡；code-review 勘误，原文误作两帧）；e2e 契约类名（`.bubble.assistant` 等）不变。

## 后果

- 迁移：3 处 `__suspend` 调用点（synthetic / brand-strategy-analysis×2）改 ask 契约；brand-research 补 brief/artifacts；turn-trigger.test 的 run_completed→事件 turn 断言**反转**（不再起 turn）；e2e-entry 全链改写（suspend→卡直出，无 ask_user 工具调用）。
- resume 拆分是行为变更：bridge /run/resume 与 askHandler 拿即时 verdict，clean 续跑 detached（对齐 start 语义）；CHAT_SYSTEM_PROMPT 与工具描述同步 resume 即返 running。
- boot 顺序约束：sweepCrashed 标 failed 时**同步写 brief=「异常终止（进程重启）」**，且 sweep 先于简报对账（否则补发文案语义劣）。
- 归档会话中的挂起卡：POST 被 409 拒（不可答）——**恢复会话即解**（归档≠删除），前端 409 文案提示「会话已归档，恢复后作答」，不开后门。
- 新列：`workflow_runs.brief` / `brief_message_id`；`SuspendSpec` 类型收紧为 breaking（单仓自研，无兼容期）。
- token 收益：完成通知从「整轮 turn + 无截断 read_run」降为 **0**。

## 关联

ADR-0007（两段式挂起力学不变）、0009（修订）、0022（修订/升格）、0026（投递管道分期承接 #19 债务与 run 卡恢复）。
