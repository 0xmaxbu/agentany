# 0031 - run 生命周期深化：RunLifecycle 单组合根 + 原子挂起/终态（ADR-0025 决策 6 落实）

日期：2026-08-19（improve-codebase-architecture 会话 grill + 对抗审查定稿；Q1–Q8 + G1/G2）

## 状态

已接受（计划实施，批次 A2；先行 A1 = ADR-0030 切片硬化原子 API）

## 背景

一次 run 的生命周期散落 runner / store / registry / briefing / hitl-dispatch / bridge 六个模块，且存在两类结构性缺欠：

- **双组合根**：`runs.ts:59-73` `buildCtx`（HTTP 同步 await）与 `registry.ts:221-226` `ctxFor`（bridge detached）近逐行复刻；HTTP 直调路径（`routes/workflows.ts:25`）只验 inputSchema、**不过审批门**（`decide()` 只在 `registry.start` 走）。
- **双 verdict 状态机**：`registry.resumeVerdict:112-125` 同步预检与 `runner.resumeInner:167-178` 权威判定两套实现，无同步测试。
- **保住惯例 seam**：`RunOutcome.payload: unknown` → `deliverAskCard` ad-hoc 重拆 + 回读 log 补 resumeSchema（`registry.ts:266`）；`deliverBrief` 收 raw log 重派生 brief。
- **ADR-0025 决策 6 字面违约（对抗审查 G1）**：决策 6 明写「run_suspended 时引擎**同事务**（挂起落库 + createQuestion 一个 SQLite 事务）直建卡」——现行实现 `runner.ts:125-129` 先 appendLog+updateRunStatus 两条独立写，registry 才在**第二个事务**写卡。崩溃落在其间 → status=suspended 但无卡。
- **终态崩溃双窗口（对抗审查 G2）**：`runner.ts:101` 先 updateRunStatus(completed) → `deliverBrief` 后写 brief+消息。窗口 A：崩在其间 → brief=null 被 reconcile（`listTerminalRunsWithoutBriefMessage` 要求 brief 非空）排除 → 永无简报；窗口 B：最后一步 appendLog 与 status 更新间崩溃 → sweep 误标 failed「异常终止」（实际已完成）。

## 决策

1. **`runs/lifecycle.ts` 导出 `RunLifecycle`**（替换 `RunRegistry`，5 处 import 改向）：组合、verdict、投递、收尾一体；runner 保持纯引擎（store 可注入、runPi 在 ctx）。
2. **单组合根**：`start({workflowId, input, conversationId?, approved?, sync?})` ——唯一 gate：validate → `decide()` 审批门 → createRun → 注册句柄 → sync=true ? await : detached。ctx 装配一份（删 buildCtx/ctxFor）。`routes/workflows.ts` 改调 lifecycle（**审批门统一堵口**）。HTTP 直调路径**无会话锚**（approval 卡需要回复锚点），require_approval 工作流经 `start` 无 `conversationId` 时 `requireApproval` 抛 `InvalidInput` → **400 堵口**（非 needs_approval）；回归见 `test/approvals.test.ts`「HTTP 旁路锁定」。审批自动化仍从会话内（IM/web 消息路由）发起。
3. **verdict 单源**：引擎公开纯函数 `verdictOf(runId, resumeData)`（clean/rejected/idempotent）；`resumeInner` 权威使用 + lifecycle 同步预检同源。
4. **引擎诚实化**：`resumeInner` 二次挂起补发 `resumeSchema`（修 runner.ts:196）；`RunOutcome.completed` 带 `lastOutput`；引擎顶层 catch-all → `failed`（永不越过状态机抛出——调用方 catch 路径与 status 双写消失）。
5. **G1 原子挂起（ADR-0025 决策 6 落实）**：RunsStore `suspendedStep(runId, {stepId, input, payload, resumeSchema}) → {questionId}`，**一个事务**写【log 行(status=suspended) + run status + ask 卡(values 快照)】。引擎挂起点直接调用 → `RunOutcome.suspended` 变纯类型 `{runId, stepId, questionId}`；**`deliverAskCard` 删除**（重拆/回读兜底全消失）；畸形产出（payload 无 question）→ 引擎走 `appendStep(suspended, 无卡)` 兜底 + `[挂起工作流]` 注入（延续 ADR-0025 决策 6 注脚）。
6. **G2 终态原子 + reconcile 扩窗**：RunsStore `appendStep`（log+status 同事务，替换裸 appendLog+updateRunStatus 对；终态换步统一走它）；reconcile 扫描改「**终态且 (brief 缺 OR briefMessageId 缺)**」，brief 缺者从 log 兜底派生（`extractBrief` 纯化，方案语义同既有对账）。窗口 A/B 归零。
7. **投递归属**：`publishOutcome` 三分支 + 终态投递为 lifecycle 私有（不抽 handler 注册表——ADR-0025 负决策守）；`briefing.ts` 保留纯 shape 源。
8. **生命周期收编**：`read/abort/sweepCrashed/reconcileBriefMessages/stopConversationRuns/requireApproval` 进 RunLifecycle；`runs.ts` 缩为 `RunDeps` + 错误类 + `makeRunId`（+ 兼容 re-export）。
9. **status 单写者**：DB run.status 只由引擎转迁（`appendStep`/`suspendedStep` 内）与终局（`setTerminalBrief`）写；lifecycle 零直写。

## 负决策

- 不建 SystemMessageHandlerRegistry 类（ADR-0025）；三分支仍是单一 coordinator 的收尾逻辑，非可插拔策略。
- 不删 `workflowRuns.status` 列：log 大量场景要按 status DB 过滤（listSuspendedRuns/listRunningRunIds/reconcile），列是必要反规范化缓存，重点是**写者唯一 + 原子**，不是删除。

## 后果

- 修订记录：ADR-0025 决策 6 现行实现系违约，本 ADR 落实字面语义（挂起 log/status/卡同一事务）。
- 5 处 import 改向（index/bridge/e2e-entry/hitl-dispatch/routes/workflows）；`registry.ts` 退休。
- 新增测试：verdictOf 直测（替代 frame polling）、双机器同源、二次挂起卡带 resumeSchema、引擎不越状态机、审批门统一（HTTP 直调堵口）、`appendStep` 原子（崩溃点三行或零行）、reconcile 扩窗（brief=null 终态补发）、sync flag 语义保留。
- 与 ADR-0030 配承：RunsStore 原子 API（`appendStep`/`suspendedStep`）在 A1 硬化 surface，A2 接线行为。

## 关联

ADR-0025（决策 6 修订落实；决策 2/3 崩溃封堵扩窗）、0007（append-only 力学不变）、0030（RunsStore 承载原子事务）。批次 A2。