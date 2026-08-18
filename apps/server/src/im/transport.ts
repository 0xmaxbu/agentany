// IM 平台接缝（spec #55/T1）：平台无关业务（渲染/路由/回流）只依赖这一个接口，零平台 if。
// 出站 = send(target, msg)；入站（事件/回调长连接）是 T2 的流侧，T1 仅钉出站。
// target = 平台用户身份（飞书为 open_id，由 imBindings 路由到）。真实平台实现见 im/feishu/transport.ts；
// 测试用 stub（test/fake-feishu.ts）扮演飞书侧，走同一契约。
export interface ImOutboundMessage {
  /** 纯文本（回执/确认/纯文本通知；卡片前的基线形态）。 */
  text?: string;
  /** 卡片 2.0 JSON（T3 起产出；互斥 text——卡片优先）。 */
  cardJson?: unknown;
}

export interface IMSendOptions {
  /** 平台层幂等键（如飞书 message uuid）：同一帧重试不双发。业务侧派生 `${questionId}:${frame.type}`。 */
  uuid?: string;
}

export interface IMPlatform {
  /** 与 imBindings.platform 对齐的值（"feishu"…）——出站路由按它选绑定。 */
  readonly platform: string;
  send(target: string, msg: ImOutboundMessage, opts?: IMSendOptions): Promise<void>;
}