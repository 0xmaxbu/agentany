# 0019 - 消息 Block 单一真相：前端 blocks 化与双发收口

日期：2026-08-14（f3 grill 定稿）

## 状态

已接受

## 背景

f1（#20）交付了后端 Block 数据契约（`blocks.ts` 四件套 + 三帧流 + pi-session reader），但为不破前端采取 block_* 与 legacy delta/done **双发**过渡。前端（f2 止）仍只消费字符串 `content`——thinking/tool_use/tool_result 在 UI 上不可见（ADR-0017 记录的 UX 痛点③「发消息不知道服务器响应」的残留根源）。

双发状态的问题：每条新帧逻辑都要考虑两条真相路径，两套迟早漂移；且前端永不切换则 f1 的 reader/双源 GET 全是死投资。

## 决策

1. **前端 UIMessage 统一 `blocks: Block[]`**（复用后端 `blocks.ts` 的 Block 类型，前端 sse.ts 复制声明）：
   - 实时：`block_start/delta/end` 三帧组装（blockId 定位，同 id 追加 delta，end 关块）
   - 历史：GET /messages 的 `HistoryMessage.blocks`（pi session reader 产出）——**同一 `MessageBlock.tsx` 渲染实时与历史，同构不分支**
   - SSE `user_message` 帧保持 string（前端包装成 text block）；GET messages 的 `content` 冗余字段前端忽略不渲染
2. **删 legacy delta，一步到位**：`delta` 帧、`runPi.ts onDelta` 参数、`turn.ts` full 攒文、web store delta 分支全删，单个 commit（双发是过渡态，不留中间态）。**保留** `done/user_message/error` 帧——done 承载 turn 边界（messageId、aborted、`sending=false`、error 回滚锚），block_end 是块边界不是 turn 边界，替代不了。
3. **done.text 同步删**（前后端一致收口）：done 不再携带全文；前端删「text 覆盖末条」逻辑——blocks 流是真相，丢帧问题属 SSE 重连债务（#19），不在渲染层补救。
4. **组装容错**：blockId 不在当前消息（断连/后端 bug）→ 静默丢弃 + `console.warn`。不在前端自动开块补救——补教会掩盖真问题。
5. **消息边界隐式跟随**：`block_start` 且当前无 streaming assistant → 自动开新 assistant 消息；done 落定。不加 turn_start/turn_end 定界帧（pi 一 turn 一 assistant 消息，实测足够；与 f2 状态机同构）。
6. **shiki 懒加载单语言**：dynamic import + createHighlighter，ts/bash/json 按需 addLanguage；流式期间纯文本，block_end 落定后异步高亮。
7. **UI 禁 emoji，图标库 = @phosphor-icons/react**（一家到底、全局 strokeWidth 1.5）：thinking 流式占位「思考中…」/终态折叠一行「已思考 N 字」可展开；tool_use 卡默认折叠（图标+一句话摘要），isError 错误摘要红字露出不折叠；tool_result 按 toolCallId 折进对应卡。f3 顺带清零存量 emoji（run 卡/HITL 卡/错误前缀）。

## 后果

- f1 契约兑现：pi session = 历史真相源在前端真正被消费。
- e2e：既有 5+1 spec **零改**继续成立（text block 渲染保持 `.bubble.assistant` DOM 契约）；新增 1 个 blocks 渲染 spec（thinking 折叠/tool_use 卡/tool_result 归卡）。
- 已知债务不变：SSE 断连丢帧无序列号恢复（#19 遗留，独立处理）。
