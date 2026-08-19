// FeishuPlatformAdapter（ADR-0032 决策 2/3/6）：ImPlatformAdapter 的双向实现——出站（transport REST）+ 入站
// （long-connection 连接 + parseInbound 信封→typed 事件 + 卡回调 ack 组装）。render 在 im/feishu/render.ts。
// feishu/{inbound,card-action}.ts 溶解进本文件 + im/dispatch.ts（domain 侧事件路由出 domain，本文件只管 wire）。
import type { ImPlatformAdapter, ImInboundEvent, ImCardModel, ImSendOptions, ImEventResult } from "../types";
import { larkEventOf, larkOperatorOpenId, larkEventTypeOf } from "./events";
import type { FeishuTransport } from "./transport";
import { FeishuLongConnection, type FeishuLongConnectionOptions } from "./long-connection";
import { renderImCard, renderSelectCard, cardJsonSize } from "./render";
import { answeredCardRsp } from "./card-rsp";
import { cardModelToText } from "../deliver";

export const FEISHU_CARD_MAX_CHARS = 30 * 1024; // 飞书整卡上限（平台特有；超限回落纯文本）

export interface FeishuAdapterOptions {
  transport: FeishuTransport;
  /** 长连接装配（决定 start 行为；缺省不启长连接 → start 仅返回 noop stop）。 */
  longConnection?: Omit<FeishuLongConnectionOptions, "onEvent" | "onCard">;
}

/** 平台 adapter：sendText/sendCard（REST）+ parseInbound（信封→typed）+ start（长连接路由+ack 组装）。 */
export class FeishuPlatformAdapter implements ImPlatformAdapter {
  readonly platform = "feishu";
  constructor(private o: FeishuAdapterOptions) {}

  sendText(to: string, text: string, opts?: ImSendOptions): Promise<void> {
    return this.o.transport.send(to, { text }, opts);
  }

  /** 渲染 + 发送；超限（30KB 平台上限）→ 自判自降纯文本（opts.textFallback；缺省领域卡文本）。 */
  async sendCard(to: string, card: ImCardModel, opts?: ImSendOptions): Promise<void> {
    const json = renderImCard(card);
    if (cardJsonSize(json) > FEISHU_CARD_MAX_CHARS) {
      return this.sendText(to, opts?.textFallback ?? cardModelToText(card), opts);
    }
    return this.o.transport.send(to, { cardJson: json }, opts);
  }

  /** 信封 → typed 事件。纯函数（不依赖连接态）。 */
  parseInbound(raw: unknown): ImInboundEvent[] | null {
    const eventType = larkEventTypeOf(raw) ?? "";
    if (eventType === "card.action.trigger") {
      const sel = mapSelectAction(raw);
      if (sel) return [{ type: "select_choice", imUserId: sel.openId, platform: "feishu", questionId: sel.questionId }];
      const m = mapCardAction(raw);
      if (m) return [{ type: "card_action", imUserId: m.openId, platform: "feishu", questionId: m.questionId, value: m.value }];
      return null;
    }
    const t = mapFeishuMessage(raw);
    if (t) return [{ type: "message", imUserId: t.openId, platform: "feishu", text: t.text }];
    return null;
  }

  /** 连接 + ack + 路由 raw → listener（决策 2：start 薄——连接/ack 在此，退避策略由 long-connection 内部件持有）。 */
  start(listener: (e: ImInboundEvent) => Promise<ImEventResult | undefined>): { stop(): void } {
    const lc = this.o.longConnection
      ? new FeishuLongConnection({
          ...this.o.longConnection,
          // 事件（im.message.receive_v1 等）→ 立即 ack + 异步 onEvent（长连接已 ack）
          onEvent: (payload: unknown) => {
            void this.dispatchRaw(payload, listener);
          },
          // 卡回调 → 处理 + 带 data 的 ack（toast + 已答卡）；非卡帧（不应发生）→ 空 ack
          onCard: async (payload: unknown) => {
            const e = this.cardEventOf(payload);
            if (!e) return undefined;
            return this.cardRsp(await listener(e));
          },
        })
      : null;
    if (lc) lc.start();
    return { stop: () => lc?.stop() };
  }

  private async dispatchRaw(payload: unknown, listener: (e: ImInboundEvent) => Promise<ImEventResult | undefined>): Promise<void> {
    try {
      const evs = this.parseInbound(payload);
      if (!evs) return; // 群聊/非文本/缺字段 → no-op（长连接仍已 ack）
      for (const e of evs) {
        const r = await listener(e);
        await this.afterMessage(r);
      }
    } catch (e) {
      console.error("[im] 入站处理失败:", e);
    }
  }

  /** 消息类结果的出站（dispatch 内已发文本回执；select_needed → 选择卡专有形态渲染后经 transport 发出——不进 ImCardModel）。 */
  private async afterMessage(r: ImEventResult | undefined): Promise<void> {
    if (!r || r.status !== "select_needed") return;
    await this.o.transport.send(r.to, { cardJson: renderSelectCard(r.candidates) })
      .catch((e: unknown) => console.warn("[im-choice] 选择卡发送失败：", e instanceof Error ? e.message : e));
  }

  /** 卡回调事件抽取（select 优先；普通卡 action 次之）；不识别 → undefined（空 ack）。 */
  private cardEventOf(payload: unknown): ImInboundEvent | null {
    const evs = this.parseInbound(payload);
    if (!evs) return null;
    const cardLike = evs.find((e) => e.type === "card_action" || e.type === "select_choice");
    return cardLike ?? null;
  }

  /** dispatch 的 card_ack 结果 → 飞书回调 rsp（toast + 可选已答卡 raw 包装）。 */
  private cardRsp(r: ImEventResult | undefined): unknown {
    if (!r || r.status !== "card_ack") return undefined;
    return answeredCardRsp(r.ack);
  }
}

// ── 信封 → 字段（原 feishu/inbound.ts + card-action.ts 的纯映射收进 adapter）──

export interface FeishuTextInbound { openId: string; text: string; }

/** 事件 payload → {openId,text}；非文本 / 群聊 / 缺字段 → null。 */
export function mapFeishuMessage(payload: unknown): FeishuTextInbound | null {
  const ev = larkEventOf(payload);
  const msg = (ev as { message?: Record<string, unknown> } | undefined)?.message;
  if (!msg) return null;
  if (msg.chat_type !== "p2p") return null; // 群聊一律忽略（v1；@ 也不处理）
  if (msg.message_type !== "text") return null; // 只回流纯文本
  const openId = (ev?.sender as { sender_id?: { open_id?: string } } | undefined)?.sender_id?.open_id;
  if (!openId) return null;
  let text: string | undefined;
  try {
    text = (JSON.parse(String(msg.content ?? "")) as { text?: string })?.text;
  } catch { return null; } // content 不是合法 JSON
  if (!text) return null;
  return { openId, text };
}

export interface CardActionInput { questionId: number; value: string; openId: string; }

/** card.action.trigger 事件 → {questionId, value, openId}；value 缺/类型错/无操作者 → null。 */
export function mapCardAction(payload: unknown): CardActionInput | null {
  const value = (larkEventOf(payload) as { action?: { value?: unknown } } | undefined)?.action?.value as { questionId?: unknown; value?: unknown } | null | undefined;
  if (!value || typeof value.questionId !== "number" || typeof value.value !== "string") return null;
  const openId = larkOperatorOpenId(payload);
  if (!openId) return null;
  return { questionId: value.questionId, value: value.value, openId };
}

/** 选择卡点击（T6）：value = { selectQuestionId } → {questionId, openId}；缺/类型错 → null。 */
export function mapSelectAction(payload: unknown): { questionId: number; openId: string } | null {
  const value = (larkEventOf(payload) as { action?: { value?: unknown } } | undefined)?.action?.value as { selectQuestionId?: unknown } | null | undefined;
  if (!value || typeof value.selectQuestionId !== "number") return null;
  const openId = larkOperatorOpenId(payload);
  if (!openId) return null;
  return { questionId: value.selectQuestionId, openId };
}

