# 0022 - 卡应答统一走消息绑定（inReplyTo），不按卡型设专用确认路由

日期：2026-08-16（#28 定时任务实现中重构；收编 #18 审批门）

## 状态

已接受

## 背景

#18 审批门落了 `POST /approvals/:id/decide`；#28 任务卡初版又落了 `POST /scheduled-tasks/confirm/:id`——同一机制（pending 卡 → 人类确认 → 服务端确定性副作用 → hitl_answered 帧）被复制两遍：每卡型一条路由、一套 CAS、一帧事件。第三种卡出现时还要再抄一遍。项目所有者指出：决策过于耦合、没有适用性——换个场景又需要重建一套同样的机制。

另一面，ask_user 卡（#16）的确认走「点选项→发消息→下一轮 pi 判答→LLM 调 resume_workflow」——对确定性动作（建任务/审批）这条路径有漂移：确认信号与参数二次经 LLM 表达，可能错判/漏判/格式漂。

## 决策

1. **一条消息通道 + kind handler 注册表**：`POST /conversations/:id/messages` 增可选 `inReplyTo`（questionId）。消息携带 id 即「这条消息是对那张卡的应答」——服务端 `hitl-dispatch` 按 `kind` 查 handler 表确定性执行，答案路由零 LLM。
2. **handler 注册表**（新卡型只注册 handler，零新路由）：`task` → 建/改任务（参数读卡上 input——建卡时已暂存，确认时零漂移）；`approval` → decide + createRun（收编 #18，含 CAS/回滚原语义）；`ask` → 选项点击确定性 resume（见决策 4）。
3. **答案仍是普通消息**：落库、进对话历史、发 user_message 帧（pi 下轮注入看到卡已 answered，不再重复判答）。卡的 answer 字段记确定性结果。
4. **ask 卡的确定性映射按约定**：手搓 resumeSchema 顶层恰一个 `enum` 属性、其余全 `optional`（可省略）时，`options[i] ↔ enum.vals[i]` 按序对位（工作流作者写 suspend 时本就按序给标签）。复杂 schema（多 enum/无 enum）→ 只 markAnswered(选项原文)，resume 留给 pi 下轮归一化；打字回答（不带 inReplyTo）完全走老判答路——语义归一化是 LLM 的功能不是漂移。
5. **确认权分卡型**：task 卡=卡主本人（自建自批，admin 不代确认，ADR-0021）；approval 卡=会话可见的任何人类（#18 审批人常是 admin 非 卡主）——「只人类」由通道保证：bridge 无消息端点，pi 持 nonce 发不出审批消息（测试锁定）。
6. **专用确认路由全删**（/approvals/:id/decide、/scheduled-tasks/confirm/:id）；前端所有卡统一「点选项 = 发消息 + inReplyTo」（`sendCardAnswer`）。

## 后果

- 新卡型 = 建 kind + 注册 handler + 前端复用同一按钮，无新确认机制。
- CAS/幂等/帧推送收在 dispatch 一处（重复确认=消息正常落库、卡不重复执行）。
- dispatch handler 的副作用失败（如 registry 不可用）记 warn 不阻塞消息（消息与卡收口解耦——卡保持 pending 可重试）。
- 旧路由删除是破坏性变更：web `decideApproval` 已删、e2e/测试全量迁移（approvals.test/task-bridge.test/workspace-authz 断言改走消息）。
