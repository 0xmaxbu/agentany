# 0032 - IM 平台 seam 双向化：typed 入站 + 渲染收进 adapter

日期：2026-08-19（improve-codebase-architecture 会话 grill 定稿，Q1–Q6）

## 状态

已接受（计划实施，批次 B1；先行 D1 = ADR-0029 的 whenDone 落到实处）

## 背景

ADR-0028 承诺「钉钉同接缝」，但平台 seam 只有**出站单向半边**，且平台无关层漏飞书形状：

- **出站只有一个透传缝**：`im/transport.ts:17` `IMPlatform.send(target, {text|cardJson})` 的 `cardJson` 是飞书形状——平台无关的 `ImOutboundRouter` 竟 import 飞书渲染 `renderImCard` 来造卡（outbound-router.ts:11,61）。
- **入站无任何 interface**：`index.ts:58-62` 把长连接 `onEvent/onCard` 直连两个开放的飞书函数 `makeFeishuInbound` + `handleCardAction`；`card-action.ts:65` 硬编码 `resolve(openId, "feishu")`。
- **映射散四文件**：EVENT/CARD 帧路由（long-connection）、信封（events.ts）、事件映射（inbound.ts）、按钮/选择映射（card-action.ts）——同一「信封→领域动作」跨四处。
- **绑定补发复渲染**：`inbound.ts:79` 直接 `renderImCard(cardInputOf(q))`，**没有** router 的 empty-options/oversize 回落守卫（outbound-router.ts:63-66）——optionless/超大卡是 live 风险。

## 决策

1. **typed 入站事件**：`ImInboundEvent` 判别联合 `{message | card_action | select_choice}`（各带 imUserId/platform/对应载荷）；领域层**单入口 `handleImEvent(deps, e)`** 按 type 路由（message → parseImCommand 命中则 handleImCommand、否则 handleImInbound；card_action/select_choice → dispatchCardAnswer/judgeAskCard + CAS）。修 `card-action.ts:65` 的 `"feishu"` 硬编码。
2. **`ImPlatformAdapter` 双向接口**：
   ```ts
   interface ImPlatformAdapter {
     platform: string;
     sendText(to, text, opts?): Promise<void>;
     sendCard(to, card: ImCardModel, opts?: { uuid?; textFallback? }): Promise<void>;
     parseInbound(raw): ImInboundEvent[] | null;                 // 信封→typed 事件（纯）
     start(listener: (e: ImInboundEvent) => void): { stop(): void }; // 连接+ack+路由 raw→parse
   }
   ```
   `start` 保持薄：**不含** ack/退避策略（各平台重连策略差异大，收进接口即假抽象）。
3. **渲染收进 adapter**：出站收**领域卡模型** `ImCardModel {prompt, options:[{label,value}], footerOpen, kind}`；Feishu Card 2.0 JSON 发射（`larkMdDiv/tag:button/schema 2.0`/`renderAnsweredCard`/`cardJsonSize`）下移 `im/feishu/render.ts`；`im/card.ts` 领域半（`cardInputOf/isTextOk/openness/KIND_TITLES`）→ `im/card-model.ts`。
4. **守卫双层**：`options.length===0`（无按钮=平台无关形态不可能）→ 领域 `im/deliver.ts` `sendCardGuarded()` 先降 `sendText(textFallback)`；**oversize**（30KB 是飞书媒体上限、平台特有）→ adapter 内部自判自降。
5. **backfill 结构性同源**：绑定补发改走**同一个 `sendCardGuarded`**（textFallback = 领域卡文本渲染）——复渲染两张脸物理合一，optionless/超大卡风险归零。
6. **文件落位**：`im/types.ts`（union/adapter/模型）、`im/card-model.ts`、`im/deliver.ts`（sendCardGuarded + renderHitlFrame 迁入）、`im/dispatch.ts`（handleImEvent/handleImCommand）；`im/feishu/render.ts`、`im/feishu/adapter.ts`（FeishuPlatformAdapter）；`feishu/{long-connection,events,pbbp2,transport}` 为 adapter 内部件；`feishu/{inbound,card-action}.ts` 溶解进 adapter。
7. **死码随行**：`ImOutboundAdapter`（im/outbound.ts:37，production 零引用仅测试保活）随 outbound.ts 溶入 deliver.ts 而删除，连带其测试段；`renderHitlFrame` 保留迁入 deliver.ts。
8. **one-adapter 立场**：生产保持 1 impl（Feishu）直到钉钉批二；但**memory adapter** 作测试第二个 impl，seam 在 harness 里变 real two-adapter——`handleImEvent` 全分支不经 fake 服务器直测。

## 负决策

- 不建「中立渲染器 + 每平台 renderer」抽象：`sendCard(领域模型)` 即 seam，Feishu 渲染在 adapter 内实现；第二个 renderer（钉钉）出现自然成立，现在建是假 seam。
- 不动 `im/store.ts`（绑定/码）与 `pending-text.ts` 的缓存设计（确认 deliberate）。

## 后果

- 新增：`handleImEvent` 全分支测试（memory adapter）、backfill 回归（optionless/oversize → sendText）、feishu adapter fixture（parseInbound 吃真实 raw 帧 → typed union；render → Card 2.0 golden）——契约测试不再依赖「fake-feishu 什么都不验证」。
- 存量 `im-*.test / card-action / choice-card / bind-code / feishu-*` 适配 import + 形状。
- `index.ts:58-62` 收窄为 `adapter.start(e => void handleImEvent(deps, e))`。

## 关联

ADR-0028（完成其「钉钉同接缝」承诺的双向半边）、0029（whenDone/回执语义由 D1 先行）、路由执行（routes/im.ts 只读 imStore，不动）。批次 B1。