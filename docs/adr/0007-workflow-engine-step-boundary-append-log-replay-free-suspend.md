# 工作流引擎：步边界 HITL + 命令式 __next + append-only 日志 + replay-free 两相 suspend

ADR-0001 定了「手搓一层薄的 Mastra 风格工作流编排层」。本 ADR 定这层的**引擎机制**——已由 Spike B（17/17 断言，见 `learnings/spike-b-results.md`、设计稿 `docs/spikes/spike-b-workflow-engine.md`）验证。四点决策：

1. **HITL / choose 是独立 step**（持久化边界天然落在步之间 + BPMN User Task / SFN Human state 惯例），**不塞进 execute**。用户「对调研不满意、要换角度」= review 步 suspend，不是上一步中途弹问。
2. **动态下一步用命令式**：`execute` 返回 `{...output, __next?: "stepId"}`；不给 `__next` 走声明顺序（`defaultNext`），给了就跳，**可往回 = 循环**（redirect 回 `s1` 并带新数据）。
3. **run 状态由 append-only 执行日志派生**（`workflow_runs` + `workflow_run_log`，ADR-0004）。每次步执行追加一条；"当前"= 最后一条；循环重跑 = 再追加（无幂等坑）；suspend/resume 都是日志条目。进程无内存态。
4. **suspend/resume = replay-free 两相**：首跑返回 `{__suspend:{payload, resumeSchema}}`（此分支须廉价、无副作用、不调 runPi）；resume 时引擎校验 `resumeData` → **重执行同一步**、`ctx.resumed=resumeData` → 走 resume 分支返回正常产出。无 JS 调用栈序列化、无重放。一步最多一次 suspend（多问 = 多步）。

API：`defineWorkflow({id,inputSchema,start}).step(id,{execute}).commit()`；`ctx={input,resumed?,runPi,projectId,runId,signal,log}`；`runner.run(wf,store,runId,ctx)` / `resume(wf,store,runId,resumeData,ctx)`。

## 备选

- **把 choose 塞进上一个 step 的 execute（中途向用户提问）**：否。要么 execute 中途阻塞（占住进程），要么需要把 JS 调用栈序列化做 replay 才能续跑——引入分布式快照机器。独立 step 让挂起点天然是持久化边界。
- **`await suspend()`（执行中途挂起，类 coroutine）**：否。隐含 replay——续跑得从挂起点恢复整个调用栈；两相模型（首跑返回 `__suspend` + resume 重执行同一步）直接绕开这个问题，且 Spike B 已证跨进程续跑成立。
- **Temporal / SFN / Restate 式基于 replay 的通用恢复**：否。我们不需要跨进程通用可恢复性机器；append-only 日志 + 步边界足够覆盖「循环 + HITL + 杀进程续跑」，且零 replay 复杂度。
- **现成工作流引擎依赖（Temporal/DBOS/@mastra workflow）**：否。重依赖、与「Pi 唯一引擎 + Bun 单进程 + 手搓薄层」整体风格不符；Spike B 证明核心引擎 < 200 行已覆盖需求。

## 后果

- **HITL 步在日志里留 2 条**（suspended + completed）——两相的自然结果，是可审计记录（何时挂起、用何数据续跑），非冗余。「逻辑路径」按 `status==="completed"` 取（results 发现 A）。
- **「杀进程续跑」零成本**：run 状态纯由日志派生，跨进程 resume 天然成立，无任何恢复机器（results 发现 B）。
- **幂等 resume** = 「当前非 suspended 即 no-op」（不重执行、不 append）；**并发 resume 竞态未覆盖**，prod 需 per-run 锁 / resume-token。
- **resumeData 校验失败零副作用**：先校验后执行，拒绝不改状态、不留垃圾日志。
- **约束**：execute 首跑分支不得有副作用、不得调 runPi（要 LLM 就拆到前一步）；一步最多一次 suspend。
- **stub → prod 迁移**（results 已记）：`schema`→zod、裸 `bun:sqlite`→Drizzle、`stubRunPi`→`apps/server/src/pi/runPi.ts`（Spike A 产出）、CLI→Hono 路由（`POST /workflows/:id/runs`、`POST /runs/:id/resume`、SSE 推进步事件）。
