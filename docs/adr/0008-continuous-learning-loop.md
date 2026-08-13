# 持续学习闭环：每次 agent 执行记过程 + 收反馈 +（后期）LLM 提取经验，反哺 chat 与 workflow

把「过程记录 + 反馈 + 经验提取」做成**系统级通用能力**，覆盖**每一次 agent 调用**（工作流运行 + 对话），不止 workflow。于是 `learnings/` 成为 chat 与 workflow **共享的知识库**，整个系统持续自提升，而非只有工作流能进步。

四件事，统一到「执行」这个概念上：

1. **过程记录 = pi session 文件**（通用，零成本）：每次 pi 调用（chat 的 rpc 或 workflow 的步）本来就 `--session-id`+`--session-dir` 把完整轨迹（推理/工具调用/产出）存盘——这就是统一的过程记录，按 session-id 定位。不新建机制。
2. **反馈 = 多态挂载**：`feedback(targetKind, targetId, text, rating?, createdAt)`，`targetKind ∈ {workflow_run, chat, …}`。现在只有 `workflow_run` 用；chat 模块上线后**同表同接口**直接挂，零改动。
3. **经验提取 = 通用 job，分两期**：
   - **前期（零新基建）**：扫 `workflow_run_logs`——工作流步产出 / `resumeData` 里已含**流程内反馈**（如 brand-strategy `select-angles` 的 `feedback`，由 runner `appendLog(runId, { … output, resumeData })` 落盘），加现有 feedback 表 + pi session 过程 → LLM 蒸馏。流程内反馈天然在 run 日志，**不必先搬进 feedback 表**。
   - **后期（数据量 / 结构需要时）**：再**建专用学习表**（归一化沉淀 run 日志里的流程内反馈 + 索引 / 分区 / 脱敏 / 保留期）。前期不建，避免过早结构化。
   - **跨工作流路由**：流程内反馈按「它评价的是**什么**」回灌，而非「在**哪个**工作流里收集」。如 `select-angles` 的 `feedback` 评价的是**角度生成（brand-research 产出）**→ 回灌 `skills/brand-research/experience.md`，不是 brand-strategy。
   - 现在留 `extractLearnings(targetKind, targetId)` 桩 + 数据契约（含 run 日志源）。
4. **经验反哺 = 直进 skill + learnings 留痕**：提取的经验**直接写进对应 skill**（`skills/<name>/experience.md`，skill 引用它 → agent 即时受益，chat+workflow 共享），`learnings/` 作**审计记录**（何时 / 从哪次执行 / 提取了什么）。**不走**「learnings 先沉淀、人工固化进 skill」的两段式——闭环更紧，agent 自动受益。

## 领域术语（补 CONTEXT.md）

- **执行 (Execution)**：一次 agent 调用（工作流运行 or 对话会话），有过程、可收反馈、可被提取经验。**工作流运行**和**对话**都是「执行」的两种形态。
- **反馈 (Feedback)**：用户对一次「执行」的评价/批注（文本 + 可选评分），是经验提取的原料。
- **经验提取 (Experience Extraction)**：从「执行过程 + 反馈」蒸馏可复用经验到 `learnings/`（后期定时 LLM 任务）。

## 备选

- **只给 workflow 加反馈/学习**：否。chat 也是 agent 调用、也该自提升；只 workflow 收益窄，且 chat 上线后再加要改表改接口。
- **立刻建 chat 侧**：否。chat 模块本身 defer；但反馈/学习层做成 `targetKind` 多态，chat 来了不用改——现在只建通用层 + workflow 侧。
- **全量执行统一进一张 `executions` 表**：否。`workflow_runs`（有步/suspend）和 `conversations`（消息流）结构差异大，强行同表别扭。**多态反馈 + pi-session 作过程**让两层解耦：领域表各自管结构，反馈/学习通用层挂在 `(targetKind, targetId)`。
- **一开始就建专用学习表**：否。流程内反馈已由 runner 落进 `workflow_run_logs`（`output` / `resumeData`），前期直接扫即可，零基建；数据量未到、结构未明时建表是过早结构化。等提取成熟、数据长了再建（见上「分两期」）。

## 后果

- `feedback` 表多态（`targetKind/targetId`）；过程记录零成本（pi session 本就在 `data/projects/<id>/pi-sessions/`）。
- 经验提取 job **分两期**：前期扫 `workflow_run_logs`（流程内反馈已在其中）+ feedback 表 + pi session，零新表；后期数据量 / 结构需要时再建专用学习表（前期不建，KISS）。现在：`extractLearnings` 桩 + 数据契约（含 run 日志源）+ `learnings/` 审计约定 + `skills/<name>/experience.md` 直写约定。
- 提取**直写 `skills/<name>/experience.md`**（append-only，不碰 skill 核心方法论，免 LLM 劣化精心写的方法论）+ `learnings/` 审计；周期性人工 review experience.md 合并进核心（可选）。
- **隐私/存储**：全量 session 记录占盘（项目 `pi-sessions/`）；后期需清理/脱敏/保留期策略（待定）。
- 关联：ADR-0001（Pi 唯一引擎，故 session 是统一过程源）、ADR-0006（项目隔离，反馈/过程按项目）、ADR-0007（工作流 run 状态）。
