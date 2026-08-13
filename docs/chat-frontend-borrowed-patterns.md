# chat 前端借模式清单（Borrowed Patterns）

切片①自建 + 借成熟模式（ADR-0009 Q-FE1=B）。本文是**实现期随时查的参考**：每条标来源（证据：源码路径）、解决什么、怎么落到我们 Hono+pi+SSE。采纳时把「状态」从 ☐ 改 ✅。

⚠ **许可证红线**：LobeChat、Open WebUI 是**限制性许可证——只学模式、不抄代码**；LibreChat / chatbot-ui / NextChat（MIT）、chat-ui（Apache-2.0）可参考实现。

## 切片①必借（流式 + 性能 + 取消）

| # | 模式 | 来源 | 解决什么 / 怎么落 |
|---|---|---|---|
| 1 | **fetch-SSE 包装**（非 EventSource） | LibreChat `sse.js`；chatbot-ui `lib/consume-stream.ts` | EventSource 不能带 auth header、只 GET。~40 行 fetch+ReadableStream+TextDecoder+按 `\n\n` 切。我们前端读 `POST /conversations/:id/messages` 的 SSE 体。 ☐ |
| 2 | **consumeReadableStream 三件套** | chatbot-ui `consume-stream.ts` + `chat-helpers/index.ts` | 最干净的可移植实现，近乎照抄，只换 parser 成我们 wire format。 ☐ |
| 3 | **parseSSE 回调契约** | NextChat `app/utils/chat.ts` | 解耦"字节怎么到"与"块什么意思"——wire format 只活这一道接缝。 ☐ |
| 4 | **rAF token-pump 平滑** | NextChat `fetchCount=max(1,round(remain/60))`/帧；LobeChat `createSmoothMessage`(~10cps+300ms 批) | 保 60fps、抗 pi 突发。包在 delta 累积外层。 ☐ |
| 5 | **原地改 + `messages.concat()` 响应式** | NextChat `app/store/chat.ts` | 流式消息同引用只改 content、数组浅拷触发订阅 → 保 scroll/markdown 缓存、灭闪烁。 ☐ |
| 6 | **乐观两消息 + 出错回滚** | chatbot-ui `chat-helpers/index.ts` | 先追加 user+空 assistant；pi/网络错 `slice(-2)` 回滚。配队列失败处理。 ☐ |
| 7 | **`ChatControllerPool`** | NextChat `Map<messageId,AbortController>` | 每消息 Stop/Retry 的易忘件，day-1 设计。配服务端 abort。 ☐ |
| 8 | **服务端取消端点** | Open WebUI `task_ids`/`stopTasksByChatId`；LibreChat `/abort` | 服务端拥有 pi 子进程→客户端 AbortController 不够，要 `POST /conversations/:id/abort`。**后端件**。 ☐ |
| 9 | **wire format：单通道 JSON-`type` 判别** | LibreChat `data-provider/types/runs.ts` | 一条 SSE event、data 是 JSON 带 `type`（`delta/done/error`，后续 `hitl_request/run_progress`）——slice②加事件零改协议。 ☐ |

## 切片②借（消息模型 + HITL + 工具步 + 上传）

| # | 模式 | 来源 | 怎么落 |
|---|---|---|---|
| 10 | **消息 dual-representation** | chat-ui `types/Message.ts` | `content:string`（持久化/搜索）+ `updates[]` 判别联合（结构化：工具步/HITL/推理）。DB 存 string、客户端 updates[] 从 SSE 派生。 ☐ |
| 11 | **HITL 生命周期（askUserQuestion）** | LobeChat `builtin-tool-user-interaction/manifest.ts` | JSON-Schema manifest + `multiSelect` + `options[]`(label/desc/recommended) + 状态机 `pending\|submitted\|skipped\|cancelled` + **pluginState 草稿持久化**（刷新不丢）+ 三渲染面（活动卡→提交后只读）。**对位 ADR-0009 ask_user + resumeSchema**。 ☐ |
| 12 | **内联活动时间线 statusHistory** | Open WebUI `ResponseMessage.svelte` | 一条事件流驱动多并行 UI 区："等待你选择"与"调用工作流 X""搜资料"排同一条时间线，spinner→✓。我们 run-log tailing 这么渲染。 ☐ |
| 13 | **工具步交错 blocks/renderUnits** | chat-ui `ChatMessage.svelte` | 走 updates→分类型块；连续 think/tool 块分组；流式中平铺、稳定后折叠"调了 N 个工具"。工作流 agent 步内联进对话。 ☐ |
| 14 | **上传：先传再发 + `{id:"loading"}` 占位** | LobeChat `file.createFile` 先返 `{id,url}`；chatbot-ui `{id:"loading"}` chip 就地换真记录 | Q9=a 上传进项目工作区：上传即返 id、消息带引用、UI loading 占位换真值。 ☐ |

## 状态管理 + 跨切

| # | 模式 | 来源 | 怎么落 |
|---|---|---|---|
| 15 | **双 map 消息状态** | LobeChat `dbMessagesMap`+`messagesMap` | 原始存真、显示层把工具消息折到 assistant 父下。 ☐ |
| 16 | **小 immer 命令式 reducer** | LobeChat `MessageDispatch` 联合 | 消息变更可预测。客户端消息 store。 ☐ |
| 17 | **拆 store（别用 mega-Context）** | chatbot-ui 巨型 Context（反例） | 拆 3–4 个小 store；用 **Zustand**（轻、NextChat/LobeChat 都用）避全局重渲染。 ☐ |

## 切片④/后期

| # | 模式 | 来源 | 怎么落 |
|---|---|---|---|
| 18 | **管理菜单：分 section + 左轨 shell** | Open WebUI `admin/Settings/*.svelte` | Q8=a 只读列表（skills+workflows+契约）用此布局。 ☐ |
| 19 | **可恢复 SSE（POST 起 → GET 订阅 → SYNC / Last-Event-ID）** | LibreChat `useResumableSSE`；chat-ui EventSource 自动重连 | 切 tab/断线不丢生成。队列已降刚需，长 run + HITL 受益——后期。 ☐ |

## 先读这 6 个文件（按性价比）

1. chatbot-ui `lib/consume-stream.ts` + `chat-helpers/index.ts` — 流式三件套（最干净，照抄级）
2. LibreChat `hooks/SSE/useSSE.ts` + `useContentHandler.ts` + `data-provider/types/runs.ts` — wire format + content 模型
3. LobeChat `builtin-tool-user-interaction/manifest.ts` — HITL 生命周期
4. NextChat `app/utils/chat.ts` + `app/store/chat.ts` — 回调契约 + 原地改+rAF + ControllerPool
5. chat-ui `types/Message.ts` + `types/MessageUpdate.ts` + `ChatMessage.svelte` — 最干净消息类型 + 工具步交错
6. Open WebUI `Chat.svelte`(chatEventHandler) + `ResponseMessage.svelte` — 事件分类 + statusHistory

## 关联
ADR-0003（传输 SSE）、ADR-0009（chat 执行与能力模型 + 切片①实现约定）。
