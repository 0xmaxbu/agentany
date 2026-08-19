# chat 助手全局沟通契约（Soul.md）

chat 回复臃肿（开场铺垫、过度解释、结尾客套、emoji）。决定：仓库根 `Soul.md` 作为助手全局沟通契约，`turn.ts` 单一注入点逐轮 append——所有经 `runTurn` 的 LLM turn（用户消息 / IM 回流 / 待处理提问判答）一致生效；headless 任务 turn（显式 `opts.appendSystemPrompt`）不注入。文件逐轮重读，改语气免改码免重启。优先级：Soul 是底线，PROJECT.md/经验只能加料不能推翻，用户当场明确要求是唯一例外（裁决规则写进 Soul.md 本身，让模型自裁）。run 边界事件经 ADR-0025 已转型零 LLM 简报/强制卡（不经 turn、天然简短），无需事件模板约束。弃选：每 workspace 一份（声音是全局的、空项目失效）、硬编码常量（调语气不该动代码）。

## 验证

机制测试（stub 断言注入位置与范围边界，`test/soul.test.ts`）+ A/B 探针 `scripts/soul-ab-probe.mjs`（注/不注 Soul 真 pi 对照，需 provider，手动跑；撰写时 provider 故障，探针只写未跑）。