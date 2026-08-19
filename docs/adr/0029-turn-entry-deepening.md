# 0029 - 起轮入口深化：一模块两入口 + 本轮产出一等结果

日期：2026-08-19（improve-codebase-architecture 会话 grill 定稿，/grill 决策 Q1–Q8）

## 状态

已接受（计划实施，批次 D1；参照 issue backlog：起轮入口深化）

## 背景

「起一轮」的 wrapper 在三个子系统各被实现了一遍，interface 各学各的：

- **Web**（`routes/conversations.ts:154-176`）：自行 429 预检 → `startInlineTurn` → 忽略产出（202 即返）
- **IM**（`im/inbound.ts:61-72`）：重复 429 预检（busy 口吻）→ `startInlineTurn` → `await queues.drained()` → **扫 DB 最后一条 assistant** 取回复——旧轮回复会撒谎，错误从不 surface（退化「已处理」）
- **定时任务**（`scheduled-tasks/execute.ts:137-156`）：**绕过 `startInlineTurn`**，自行复刻 appendMessage+touch+publish+enqueue，靠 send 闭包收集 messageId/error + 文件钩子

根因：`runTurn`（`chat/turn.ts:44`）是共享深 module，但「本轮产出了什么」没有一等结果——每个调用方各猜各的（EventBus 帧 / DB 扫 / send 闭包）。429/busy 预检两处 copy，`eventBus?` 可选导致帧静默丢弃。

## 决策

1. **一模块两薄入口**（`chat/turn-entry.ts`）：`startUserTurn(ctx, convId, content, {skipTurn?, focusQuestionId?})` 与 `startSystemTurn(ctx, convId, content, {taskId?, extensions?, appendSystemPrompt?})`，两者调用**私有 deep core**。对应 CONTEXT 轮模型「输入双源（用户输入/系统消息）」与现有两个 queue flavor（HTTP 429 / Event cap）。`inline-turn.ts` 删除。
2. **本轮产出一等结果**：入口返 `{ status: busy | accepted | appended_only, messageId, whenDone: Promise<TurnOutcome> }`，`TurnOutcome = done{messageId} | error{error} | aborted`。Web 忽略 whenDone（202 即返）；IM/task await（IM 按 **messageId 定向读**回复——删 DB 扫最后一条；task 拿 messageId+error——删 send 闭包收集）。
3. **busy/429 预检内聚 core**：`queueKind=user` 时在**任何 DB 写入前**预检（`wouldAcceptHttpTurn`），拒 → `busy`（未落库）；`skipTurn` 绕过队列（程序化轮永不 429）。双保险入队失败 → `appended_only`（消息已落 + error 帧已发；Web 仍 202、IM 报 busy 文案——沿用现状口径）。删两处调用方预检（`conversations.ts:173` / `im/inbound.ts:64`）。
4. **publish 强制注入**：core 必收 `publish: (frame) => void`（路由传共享闭包 bus、IM/task 传 `deps.eventBus`、测试传收集器）——消灭 `eventBus?.` 静默丢弃路径，入口永不自建 EventBus。
5. **队列 `drained()` 公开面删除**（`ConversationQueues`）：其两个生产调用方（IM/task）改 await whenDone；泳测试等待也改 whenDone。
6. **IM error 路径短回执**：whenDone 落 error → IM 回「处理失败，请重试或点选卡片」+ server log（贴合 CONTEXT「回执不假装成功」），不再退化陈旧回复。
7. **fold-in：`runTurn` 工作流查找注入**：`turn.ts:65` 的全局 `listWorkflows()` 改为经 deps 注入——runTurn 测试不再忍全局 registry 状态。
8. **引擎不动**：`runTurn` 零改动（entry 对 send 钩子加 interceptor 收集终结帧）。

## 负决策

- 不把 dispatchCardAnswer 收进 turn-entry——卡应答的跳轮判定是 hitl-dispatch 关注点，入口只接 `skipTurn` 旗标。
- 不做第二个事件入口类——两薄入口 + 共享 core 已收敛三副本（ADR-0025 决策 9「谁消费输入谁起轮」不变，不重建 TestBed 中转）。

## 后果

- 删除 `chat/inline-turn.ts`；改 3 处调用（conversations route / im judgeAskCard / execute task wrapper）。
- IM 从「扫最后一条 assistant」改为「按 messageId 定向读」——旧轮回复撒谎窗口归零。
- 新增 `test/turn-entry.test.ts`：busy 写入前序、skipTurn 绕过、appended_only、error 路径、system flavor 透传、whenDone。
- 存量 `turn-inline.test.ts` 不动（直达 runTurn 引擎）。

## 关联

ADR-0025（决策 9「谁消费输入谁起轮」修订收口）、0024（Soul 注入点不变）。批次 D1。