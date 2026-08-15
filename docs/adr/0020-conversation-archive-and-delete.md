# 0020 - 会话删除与归档

日期：2026-08-15（grill 定稿）

## 状态

已接受

## 背景

会话只能建不能删/藏——侧栏无限膨胀，废弃会话永远占据列表。挂靠数据四类：messages、hitl_questions、workflow_runs（conversationId 可空）、pi session jsonl 文件。权限基线：会话一律创建者私有（+admin）（ADR-0018）。

## 决策

1. **删除与归档是两个独立操作**：
   - **归档**（可逆软态）：从主列表移除、可恢复、可看历史（只读）
   - **删除**（不可逆硬删）：确认后全链清理
2. **权限**：删除仅 admin；归档/恢复 = 创建者自己 + admin（会话私有语义延伸——藏自己的会话不需特权）。
3. **归档 = `conversations.archivedAt` 列**（null=活跃，迁移加列）：服务端真相。GET /conversations 默认只返活跃；`?archived=1` 返归档。归档/恢复 = PATCH archivedAt。
4. **归档会话可看不可发**：GET messages 正常；POST /messages 对已归档会话 409（前端 composer 禁用 + 占位文案「已归档，恢复后可继续对话」，后端拒绝双保险）。
5. **硬删全链清理**（admin-only）：DB 删 conversations/messages/hitl_questions 行；workflow_runs.conversationId **置空解绑而非删**（run 是 workspace 资产非会话子资产，ADR-0018 口径；suspended run 不杀）；pi session jsonl unlink；内存态 abort（活跃 turn 杀 pi 子进程 + SSE/EventBus detach）。
6. **先杀后删**：删除/归档时若该会话有在跑 turn → 复用 queues.abort + runRegistry.stopConversationRuns（#19 既有机制）先停，再执行。
7. **UI**：侧栏项悬浮菜单（member：「归档」；admin：+「删除」带确认弹层）；侧栏底部「归档」折叠入口 → 展开归档列表（每项「恢复」；admin 另见「删除」）。
8. **测试**：后端单测（归档过滤/恢复/硬删全链/权限 403/在跑先杀）+ 1 个新 e2e spec（用户视角归档→恢复→admin 删除全链）。既有 7 spec 零改闸门不变。

## 后果

- 迁移：conversations 加 archivedAt text 可空列（drizzle 迁移 0011）。
- store 新增：archiveConversation / restoreConversation / deleteConversation（事务内全链）。
- 路由：PATCH /conversations/:id/archive、/:id/restore、DELETE /conversations/:id。
- ADR-0018 的「ws 删除/archive 推迟项」不受影响（那是 workspace 级，本 ADR 是会话级）。
