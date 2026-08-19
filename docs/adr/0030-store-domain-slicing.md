# 0030 - store 按领域切 seam：四域 store + createStores 单点装配

日期：2026-08-19（improve-codebase-architecture 会话 grill 定稿，Q1–Q6）

## 状态

已接受（计划实施，批次 A1；参照 issue backlog：store 切片）

## 背景

`workflow-engine/store.ts`（674 行、全仓近 20 commits 变更冠军）一个 adapter 同时拥有 **five 域 43 个公开方法**：runs/log、hitl 卡、conversations、messages、feedback。被 11 个文件跨 8 个 feature 区 import——每个无关功能（IM、distill）被迫认识整个 43 方法 interface 只为一条查询（如 distill 只要 `listFeedbackSince/maxFeedbackId/conversationOfFeedbackTarget` 三个）。同时漏出序列化惯例：ask 卡 decision 素材 context 被**走私进 input 列**（写处 `registry.deliverAskCard:275` 要知道 `{context}` 包装约定、读处 `toQuestionRow:660-665` 反解）。

## 决策

1. **物理拆四域四文件**（含域类型随文件带走）：
   - `runs/store.ts` `RunsStore`：`createRun/appendLog/getRun/getLog/updateRunStatus/listRunsForConversation/listRunsWithSteps` + 跨域事务
   - `hitl/store.ts` `HitlStore`：`createQuestion/getQuestion/listQuestions/getPendingByRun/markPendingAnsweredByRun/markQuestionAnswered/getPendingApproval/markApprovalDecided/backfillApprovalRunId/reopenApproval/markTaskCardDecided/listPendingCardsForUser`
   - `chat/store.ts` `ChatStore`：conversations（create/get/touch/rename/list/archive/restore/delete）+ messages（append/list）
   - `feedback/store.ts` `FeedbackStore`：`addFeedback/getFeedback/listFeedbackSince/maxFeedbackId/conversationOfFeedbackTarget/conversationIdOfMessage/conversationIdOfRun`
2. **跨域事务按 subject 归属**：`setTerminalBrief`/`suspendWithAskCard` → **RunsStore**（run 为 subject；message/question 是同一 run 生命周期事务的副作用）；`deleteConversation` → **ChatStore**（会话级联）。不抽第五个「组合事务 store」（单组合源不建模块）。
3. **`hitl_questions.context` 列**（drizzle 迁移 0022；计划号 0019 因 values 迁移 0019 先落位而顺延）：ask 卡 decision 素材一等列；写处收 typed `{prompt, options, values, context?}`，读处直读——**退役 `input-as-{context}` 走私约定**。v1 未发布零兼容负担。
4. **`db-utils.ts`**：`now()/J/P` + 单调时钟（四类共享）。
5. **`createStores(db)` 工厂**：返 `{runs, chat, hitl, feedback}`；boot（index.ts）与 `test/deps.ts` 共用——装配知识单点。
6. **`RunDeps.store` 拆四域字段** `runStore/chatStore/hitlStore/feedbackStore`；runner 参数 `WorkflowStore` → `RunsStore`（引擎只学 runs 面）。
7. **删死码 `listPendingCardForUser`（单数）**：全仓零 caller（ADR-0028 决策 3 反转前旧语义残留），HitlStore 切片时不带过河。
8. **`runPi` 相关 store 事务不在本 ADR**——见 ADR-0031（原子挂起/终态在此文件落位，接口由 0031 定型后 A1 实施一并切）。

## 负决策

- **不建 interface views/facade 保单类**：interface 收窄只是幻觉，implementation 仍在 674 行互扰；物理拆分才给变更 locality。
- **不动 `ApiStore` 形态的传 db 泛型 hack 与 `insertQuestion` 单点收敛**（已 deep，原样带过河）。

## 后果

- `createStores` 单测（共享 db + 单调时钟）；存量 CAS/事务测试分文件适配；全量 tsc + bun test。
- 每域调用方收敛到自己的小 interface（distill 3 方法、IM 卡 4 方法、引擎 runs 面）。
- `RunDeps` 字段增 3（14→17）——**不单开 god-object 改造**；立非目标公约：消费者按需做 per-consumer 参数收窄（TS Pick，与决策 6 同哲学、零结构搬迁）。

## 关联

ADR-0026（域表为真相——切片保有域真相语义）、0031（RunsStore 原子事务 / 0031 依赖本 ADR 的 RunsStore 面）、0028（listPendingCardForUser 消亡根因）。批次 A1。