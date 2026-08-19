// IM 平台 seam 双向化（ADR-0032）：typed 入站 + 渲染收进 adapter。
// - 入站：ImInboundEvent 判别联合（message / card_action / select_choice），平台无关，各带 imUserId/platform。
// - 出站：ImPlatformAdapter.sendText/sendCard（领域卡模型）——渲染在平台 adapter 内。
// - 平台层（FeishuPlatformAdapter）与测试 memory adapter 各实现之——seam 双侧真实。
import type { QuestionRow } from "../hitl/store";

export interface ImCardOption {
  label: string;
  value: unknown;
}

/** 领域卡模型（ADR-0032 决策 3）：平台无关；footerOpen 由领域层判（isTextOk），渲染只消费。 */
export interface ImCardModel {
  kind: "ask" | "approval" | "task";
  questionId: number;
  prompt: string;
  options: ImCardOption[];
  footerOpen: boolean;
}

/** typed 入站事件（决策 1）：parseInbound（信封→typed，纯）产出；handleImEvent 按 type 路由。 */
export type ImInboundEvent =
  | { type: "message"; imUserId: string; platform: string; text: string }
  | { type: "card_action"; imUserId: string; platform: string; questionId: number; value: string }
  | { type: "select_choice"; imUserId: string; platform: string; questionId: number };

export interface ImSendOptions {
  uuid?: string; // 平台层幂等键（如飞书 message uuid）
  textFallback?: string; // sendCard 超限自降时用（平台 adapter 自判）
}

/** 卡回调 ack 素材（决策 2 的「ack 组装留 feishu 侧」前半）：领域回 ack 素材，平台 adapter 组装 feishu rsp。 */
export interface ImCardAck {
  toast: { type: "success" | "info" | "error"; content: string };
  answered: boolean; // 已答/幂等 → 平台渲染已答态卡；false → 仅 toast
  question?: QuestionRow | null; // 已答态卡素材（更新原卡）
}

/** handleImEvent 统一返回：消息类（ignored/processed/select_needed）出站或由 dispatch 内发、或交平台渲染；卡类带 ack 素材。 */
export type ImEventResult =
  | { status: "ignored" }
  | { status: "processed" }
  | { status: "select_needed"; to: string; candidates: { questionId: number; prompt: string }[] } // 多卡消歧：平台 adapter 渲染选择卡
  | { status: "card_ack"; ack: ImCardAck };

/** 双向平台接缝（决策 2）：出站两件（text/card）+ 入站两件（parseInbound 纯映射 / start 连接+ack+路由）。 */
export interface ImPlatformAdapter {
  readonly platform: string;
  sendText(to: string, text: string, opts?: ImSendOptions): Promise<void>;
  sendCard(to: string, card: ImCardModel, opts?: ImSendOptions): Promise<void>;
  /** 信封 → typed 事件（纯函数；非本平台可 parse 的帧 → null）。 */
  parseInbound(raw: unknown): ImInboundEvent[] | null;
  /** 连接 + ack + 路由 raw → listener。start 保持薄：不含退避策略（各平台重连策略差异大，收进接口即假抽象）。 */
  start(listener: (e: ImInboundEvent) => Promise<ImEventResult | undefined>): { stop(): void };
}