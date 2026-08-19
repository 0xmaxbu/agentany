// IM 领域单入口（ADR-0032 决策 1）：handleImEvent(deps, e) 按 typed 事件路由。
// - message → parseImCommand 命中则 handleImCommand（#bind/#unbind，平台无关化）；否则 handleImInbound（回流判答）。
// - card_action / select_choice → dispatchCardAnswer / judgeAskCard + CAS（卡回调经 out 回 ack 素材）。
// 出站：文本回执直接 out.sendText（文本平台无关）；选择卡/已答卡 ack 由各平台 adapter 自行渲染（render 留 feishu 侧）。
import type { RunDeps } from "../runs";
import type { ImInboundEvent, ImEventResult, ImPlatformAdapter } from "./types";
import { parseImCommand, type ImCommand } from "./commands";
import { handleImInbound, judgeAskCard } from "./inbound";
import { dispatchCardAnswer } from "../chat/hitl-dispatch";
import type { PendingTextCache } from "./pending-text";
import { sendCardGuarded } from "./deliver";
import { cardInputOf } from "./card-model";

const UNBOUND_TOAST = { type: "error" as const, content: "请先在 Web 绑定后再操作" };

/** 卡回调前置守卫（card_action/select_choice 共用）：身份 → 卡存在 → pending 判定。ok 时带解析 identity 与卡；否则给 ack。 */
function guardCardEvent(
  deps: RunDeps,
  e: { imUserId: string; platform: string; questionId: number },
): { ok: true; user: NonNullable<ReturnType<NonNullable<RunDeps["imStore"]>["resolve"]>>; q: NonNullable<ReturnType<RunDeps["hitlStore"]["getQuestion"]>> } | { ok: false; ack: ImEventResult } {
  const user = deps.imStore?.resolve(e.imUserId, e.platform);
  if (!user) return { ok: false, ack: { status: "card_ack", ack: { toast: UNBOUND_TOAST, answered: false } } };
  const q = deps.hitlStore.getQuestion(e.questionId);
  if (!q) return { ok: false, ack: { status: "card_ack", ack: { toast: { type: "error", content: "卡已失效" }, answered: false } } };
  if (q.status !== "pending") {
    return { ok: false, ack: { status: "card_ack", ack: { toast: { type: "info", content: "该卡已被处理" }, answered: true, question: q } } };
  }
  return { ok: true, user, q };
}

/** #bind 命中后一次性补发全部存量 pending 卡（素材与出站路由同源 cardInputOf；uuid 同路由幂等键；走 sendCardGuarded 守卫）。 */
async function backfillPendingCards(deps: RunDeps, out: ImPlatformAdapter, imUserId: string, platform: string, userId: string): Promise<number> {
  const pendings = deps.hitlStore.listPendingCardsForUser(userId);
  for (const q of pendings) {
    await sendCardGuarded(out, imUserId, cardInputOf(q), { uuid: `${q.id}:hitl_request` })
      .catch((e: unknown) => console.warn(`[im-bind] 补发卡 ${q.id} 失败：`, e instanceof Error ? e.message : e));
  }
  return pendings.length;
}

/** 私聊命令执行（平台无关：#bind 消费码→绑定→补发；#unbind 解绑）。返回复文本。 */
export async function handleImCommand(
  deps: RunDeps, cmd: ImCommand, e: Extract<ImInboundEvent, { type: "message" }>, out: ImPlatformAdapter,
): Promise<string> {
  const platform = e.platform;
  if (cmd.kind === "unbind") {
    const had = deps.imStore?.unbind(e.imUserId, platform);
    return had ? "已解绑。需要重新绑定请在 Web 获取绑定码。" : "当前未绑定，无需解绑。";
  }
  // bind：单调通道——先查已绑（同一 im_user_id 重复绑定提示/换绑先 #unbind）；余人校验码 + 绑定
  if (deps.imStore?.resolve(e.imUserId, platform)) {
    return "您已绑定。如需换绑请先发 #unbind 再找新绑定码。";
  }
  const claimed = deps.imStore?.consumeBindCode(cmd.code);
  if (!claimed) return "绑定码无效或已过期，请在 Web 重新获取。";
  const row = deps.imStore?.bind(e.imUserId, platform, claimed.userId);
  if (!row) return `绑定失败：该账号可能已在 ${platform} 绑定过其他身份。请先 #unbind 旧绑定再试。`;
  // 成功 → 一次性补发全部存量 pending 卡
  const n = await backfillPendingCards(deps, out, e.imUserId, platform, claimed.userId);
  return n > 0 ? `绑定成功！当前有 ${n} 张待处理卡片，已补发。` : "绑定成功！当前没有待处理卡片。";
}

/** card_action 结算（T4）：解析 → 卡存在性/pending → dispatch（CAS）→ 返回 ack 素材（feishu adapter 组 rsp）。 */
export async function handleCardActionEvent(
  deps: RunDeps,
  e: Extract<ImInboundEvent, { type: "card_action" }>,
): Promise<ImEventResult> {
  const g = guardCardEvent(deps, e);
  if (!g.ok) return g.ack;
  const { user, q } = g;
  const res = await dispatchCardAnswer(deps, q.conversationId, e.questionId, e.value, user.userId);
  if (!res.handled) {
    if (res.skipTurn) return { status: "card_ack", ack: { toast: { type: "info", content: "该卡已被处理" }, answered: true, question: q } };
    return { status: "card_ack", ack: { toast: { type: "error", content: "无法处理该操作" }, answered: false } };
  }
  if (res.error) return { status: "card_ack", ack: { toast: { type: "error", content: res.error }, answered: false } };
  const okMsg: Record<string, string> = { ask: "已处理", approval: "已审批", task: "已确认" };
  return { status: "card_ack", ack: { toast: { type: "success", content: okMsg[q.kind ?? "ask"] ?? "已处理" }, answered: true, question: q } };
}

/** select_choice（T6）：取缓存文本 → 异步对所选卡走单卡判答（judgeAskCard）+ CAS；即时 ack「已收到，正在处理…」。 */
export async function handleSelectChoice(
  deps: RunDeps,
  e: Extract<ImInboundEvent, { type: "select_choice" }>,
  out: ImPlatformAdapter,
  textPending: PendingTextCache | undefined,
): Promise<ImEventResult> {
  const g = guardCardEvent(deps, e);
  if (!g.ok) return g.ack;
  const { user, q } = g;
  if (!textPending) return { status: "card_ack", ack: { toast: { type: "error", content: "选择卡未就绪，请重新输入回答" }, answered: false } };
  const text = textPending.get(e.imUserId);
  if (!text) return { status: "card_ack", ack: { toast: { type: "error", content: "待回答的文本已过期，请重新输入回答" }, answered: false } };
  // 判答异步（LLM 轮可能 >3s，不进 ack 窗口；飞书 3s 无响应会重推 → CAS 幂等）。结果经 out.sendText 回执。
  void (async () => {
    try {
      await judgeAskCard(deps, q, text);
      const after = deps.hitlStore.getQuestion(e.questionId);
      if (!after || after.status !== "answered") {
        await out.sendText(e.imUserId, "暂时无法据此推进，请重试或点选卡片选项"); // 归一化失败，缓存保留
        return;
      }
      textPending.del(e.imUserId); // 成功消费（下次打字再起新选择）
      await out.sendText(e.imUserId, "已处理");
    } catch (err) {
      console.warn(`[im-select] 选择卡判答 q${e.questionId} 失败：`, err instanceof Error ? err.message : err);
      await out.sendText(e.imUserId, "暂时无法据此推进，请重试或点选卡片选项");
    }
  })();
  return { status: "card_ack", ack: { toast: { type: "info", content: "已收到，正在处理…" }, answered: false } };
}

/** 领域单入口（决策 1）：typed 事件 → domain 路由；返回 ack 素材（平台 adapter 组 rsp）或 processed/ignored。
 *  out = 触发本事件的平台 adapter（文本回执直接经它发；无绑定/etc 静默丢弃）。pending = 选择卡待确认文本缓存（可选）。 */
export async function handleImEvent(
  deps: RunDeps,
  e: ImInboundEvent,
  out: ImPlatformAdapter,
  pending?: PendingTextCache,
): Promise<ImEventResult> {
  switch (e.type) {
    case "message": {
      const cmd = parseImCommand(e.text);
      if (cmd) {
        const reply = await handleImCommand(deps, cmd, e, out);
        await out.sendText(e.imUserId, reply);
        return { status: "processed" };
      }
      const res = await handleImInbound(deps, { imUserId: e.imUserId, platform: e.platform, text: e.text }, pending);
      if (res.reply) await out.sendText(e.imUserId, res.reply); // 回发处理确认（丢弃无回复）
      if (res.status === "choice_needed" && res.candidates && res.candidates.length > 1) {
        return { status: "select_needed", to: e.imUserId, candidates: res.candidates }; // 选择卡由平台 adapter 渲染
      }
      return { status: res.status === "discarded" ? "ignored" : "processed" };
    }
    case "card_action":
      return handleCardActionEvent(deps, e);
    case "select_choice":
      return handleSelectChoice(deps, e, out, pending);
  }
}