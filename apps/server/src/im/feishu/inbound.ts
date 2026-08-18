// 飞书入站事件映射 + 回流 glue（spec #55/T2 #57）。长连接 client 只负责帧/ack/异步 onEvent；
// 本文件负责「事件 → 文本回流」（复用平台无关的 handleImInbound）+「回复经 send 出」。
//
// im.message.receive_v1 事件进入文本回流的口径（与 #49 决策 2 一致）：
// - message_type != text → 忽略（图片/文件等不走回流）
// - chat_type != p2p（群聊，含 @）→ 忽略（v1 只做单聊）
// - 缺 sender_id.open_id / content 非 {text} → 忽略
// - 未绑定用户 → handleImInbound 内部丢弃（no-op）
import type { RunDeps } from "../../runs";
import type { IMPlatform } from "../transport";
import { handleImInbound } from "../inbound";

export interface FeishuTextInbound {
  openId: string;
  text: string;
}

/** 事件 payload → {openId,text}；非文本 / 群聊 / 缺字段 → null。纯函数，单测直测。 */
export function mapFeishuEvent(payload: unknown): FeishuTextInbound | null {
  const ev = (payload as { event?: Record<string, any> }).event;
  const msg = ev?.message as any;
  if (!msg) return null;
  if (msg.chat_type !== "p2p") return null; // 群聊一律忽略（v1；@ 也不处理）
  if (msg.message_type !== "text") return null; // 只回流纯文本
  const openId = (ev?.sender as any)?.sender_id?.open_id;
  if (!openId) return null;
  let text: string | undefined;
  try {
    text = (JSON.parse(msg.content) as { text?: string })?.text;
  } catch { return null; } // content 不是合法 JSON
  if (!text) return null;
  return { openId, text };
}

/** 组合回流入站：事件 → 文本回流 → 命中回发到发送者 open_id（经 T1 的 platform.send）。 */
export function makeFeishuInbound(deps: RunDeps, platform: IMPlatform): (payload: unknown) => Promise<void> {
  return async (payload: unknown) => {
    const r = mapFeishuEvent(payload);
    if (!r) return; // 非文本/群聊/缺字段 → no-op（长连接仍已 ack）
    const res = await handleImInbound(deps, { imUserId: r.openId, platform: platform.platform, text: r.text });
    if (res.reply) await platform.send(r.openId, { text: res.reply }); // 回发处理确认（丢弃无回复）
  };
}