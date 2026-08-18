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
import { parseImCommand, type ImCommand } from "../commands";
import { renderImCard, renderSelectCard, cardOptionsOf } from "../card";
import type { PendingTextCache } from "../pending-text";

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

/** 组合回流入站：事件 → 命令层（#bind/#unbind）或文本回流 → 命中回发到发送者 open_id。
 *  未绑定用户：命令 → 有回执（引导）；普通文本 → handleImInbound 静默丢弃（永不影响会话）。
 *  textPending = 选择卡待确认文本缓存（与卡回调 handleCardAction 共享同一实例）。 */
export function makeFeishuInbound(deps: RunDeps, platform: IMPlatform, textPending?: PendingTextCache): (payload: unknown) => Promise<void> {
  return async (payload: unknown) => {
    const r = mapFeishuEvent(payload);
    if (!r) return; // 非文本/群聊/缺字段 → no-op（长连接仍已 ack）
    const cmd = parseImCommand(r.text);
    if (cmd) {
      const reply = await handleFeishuCommand(deps, platform, r.openId, cmd);
      if (reply) await platform.send(r.openId, { text: reply });
      return;
    }
    const res = await handleImInbound(deps, { imUserId: r.openId, platform: platform.platform, text: r.text }, textPending);
    if (res.reply) await platform.send(r.openId, { text: res.reply }); // 回发处理确认（丢弃无回复）
    if (res.status === "choice_needed" && res.candidates && res.candidates.length > 1) {
      // 多卡 → 选择卡（列出各卡 prompt；无 uuid——重发靠新卡，uuid 会压掉覆盖重发的选择卡）
      await platform.send(r.openId, { cardJson: renderSelectCard(res.candidates) })
        .catch((e: unknown) => console.warn("[im-choice] 选择卡发送失败：", e instanceof Error ? e.message : e));
    }
  };
}

/** 私聊命令执行：#bind 消费码→绑定→一次性补发存量卡；#unbind 解绑。返回复文本。 */
async function handleFeishuCommand(deps: RunDeps, platform: IMPlatform, openId: string, cmd: ImCommand): Promise<string> {
  if (cmd.kind === "unbind") {
    const had = deps.imStore?.unbind(openId, platform.platform);
    return had ? "已解绑。需要重新绑定请在 Web 获取绑定码。" : "当前未绑定，无需解绑。";
  }
  // bind：单调通道——先查已绑（同一 open_id 重复绑定提示/换绑先 #unbind）；余人校验码 + 绑定
  if (deps.imStore?.resolve(openId, platform.platform)) {
    return "您已绑定。如需换绑请先发 #unbind 再找新绑定码。";
  }
  const claimed = deps.imStore?.consumeBindCode(cmd.code);
  if (!claimed) return "绑定码无效或已过期，请在 Web 重新获取。";
  const row = deps.imStore?.bind(openId, platform.platform, claimed.userId);
  if (!row) return "绑定失败：该账号可能已在飞书绑定过其他身份。请先 #unbind 旧绑定再试。";
  // 成功 → 一次性补发全部存量 pending 卡（素材与出站路由同源 cardOptionsOf；uuid 同路由幂等键）
  const pendings = deps.store.listPendingCardsForUser(claimed.userId);
  for (const q of pendings) {
    const card = renderImCard({ questionId: q.id, kind: (q.kind ?? "ask") as "ask" | "approval" | "task", prompt: q.prompt, options: cardOptionsOf(q), resumeSchema: q.resumeSchema });
    await platform.send(openId, { cardJson: card }, { uuid: `${q.id}:hitl_request` })
      .catch((e: unknown) => console.warn(`[im-bind] 补发卡 ${q.id} 失败：`, e instanceof Error ? e.message : e));
  }
  return pendings.length > 0
    ? `绑定成功！当前有 ${pendings.length} 张待处理卡片，已补发。`
    : "绑定成功！当前没有待处理卡片。";
}