# Pi 作为唯一 LLM 引擎，叠加手搓的 Mastra 风格工作流编排层

聊天界面需要一个能"程序化调用 + 工作流调工作流 + 中途挂起等人"的工作流层。决定：**Pi 是唯一的 LLM 引擎**（闲聊和每步思考都走 Pi，`pi -p --mode json` 一次性 / `--mode rpc` 长连接）；工作流编排**手搓一层薄的、借鉴 Mastra 解耦设计的层**（fluent builder `defineWorkflow(id).step().step().commit()`、步间 zod 契约、suspend/resume、durable run 状态），**不引入 `@mastra` 依赖**。

## 备选

- **直接采用 @mastra 的 workflow 半边**：否。Mastra 是个 agent runtime、想自己拥有 LLM，会与 Pi 抢"大脑"位置；我们只需它的解耦思路，不需要它的运行时。
- **Pi 散文工作流（现状 `workflows/*.md` 由 Pi 直接执行）**：否。无类型化 I/O、无原生 suspend/resume、组合非正式，撑不起"程序化调用 + 工作流调工作流"。

## 后果

- `workflows/*.md` 从"工作流本体"降级为"人类可读规格"，实际工作流是 TS 代码（每个 markdown 对应一个 coded workflow）。
- 工作流的思考步 = `runPi()` 调 `pi -p --mode json` 解析 NDJSON（攒 `text_delta`、取 `turn_end.toolResults`、`agent_end.messages`）；跨步连续性靠 `--session-id`。
- 头号实现风险见 `learnings/pi-headless-extension-ui-handshake.md`。
