// 飞书回调/事件信封导航（spec #55）：{schema, header:{event_type,...}, event:{...}}。
// 卡片回调（card.action.trigger）与消息事件（im.message.receive_v1）共用同一信封形——集中取字段，
// 避免各 handler 重复 `(payload as {event}).event` / `.operator?.open_id`（code-review Standards #4）。

/** 信封 → event 对象；缺/非对象 → undefined。 */
export function larkEventOf(payload: unknown): Record<string, unknown> | undefined {
  const ev = (payload as { event?: unknown }).event;
  return ev && typeof ev === "object" ? (ev as Record<string, unknown>) : undefined;
}

/** 信封 → event_type（header.event_type）——长连接帧层分流卡片回调用；缺 → undefined。 */
export function larkEventTypeOf(payload: unknown): string | undefined {
  const t = (payload as { header?: { event_type?: unknown } })?.header?.event_type;
  return typeof t === "string" && t.length > 0 ? t : undefined;
}

/** 信封 → operator.open_id（点击者/发送者身份锚）；缺 → undefined。 */
export function larkOperatorOpenId(payload: unknown): string | undefined {
  const openId = (payload as { event?: { operator?: { open_id?: unknown } } })?.event?.operator?.open_id;
  return typeof openId === "string" && openId.length > 0 ? openId : undefined;
}