// IM 出站路由胶水（spec #55/T1+T3）：EventBus 帧 →「会话 owner 的绑定 → 该平台的 IM 身份」→ 平台 send。
// T3（#58）：hitl_request → 交互卡片（renderImCard，按钮 value={questionId, label}）；hitl_answered → 确认回执文本。
// 都是「一帧多端」里 IM 那端的收件人解析：卡帧在会话 c1 出现，Web 走 SSE 显卡、IM 走这里发给 c1.owner 绑定的 open_id。
// 订阅按「已绑定用户的活动会话」建立，绑定变更（自助绑定 T5）后重扫 subscribeAll() 即可（幂等）。
// uuid 派生 `${questionId}:${frame.type}`：平台层幂等键（飞书 1h 去重窗）——瞬时故障重试不双发卡/回执。
import type { Frame } from "../chat/eventbus";
import { EventBus } from "../chat/eventbus";
import type { WorkflowStore } from "../workflow-engine/store";
import { ImStore } from "./store";
import { renderHitlFrame } from "./outbound";
import { renderImCard, cardJsonSize, type ImCardOption } from "./card";
import type { IMPlatform, ImOutboundMessage } from "./transport";

const MAX_CARD_CHARS = 30 * 1024; // 飞书整卡上限；超限回落纯文本（不丢通知）

export interface OutboundRouterDeps {
  store: WorkflowStore;
  imStore: ImStore;
  bus: EventBus;
  platform: IMPlatform;
}

export class ImOutboundRouter {
  private unsubs = new Map<string, () => void>();
  private render: (f: Frame) => string | null;

  constructor(private deps: OutboundRouterDeps, render?: (f: Frame) => string | null) {
    this.render = render ?? renderHitlFrame;
  }

  /** 幂等重扫：把「当前已绑定用户的活动会话」都挂上订阅（重复调用不重复订阅）。 */
  subscribeAll(): void {
    for (const b of this.deps.imStore.list()) {
      if (b.platform !== this.deps.platform.platform) continue;
      for (const convId of this.activeConversationsOf(b.userId)) {
        if (this.unsubs.has(convId)) continue;
        const un = this.deps.bus.subscribe(convId, (f) => void this.onFrame(convId, f));
        this.unsubs.set(convId, un);
      }
    }
  }

  private activeConversationsOf(userId: string): string[] {
    return this.deps.store.listConversations(userId) // 缺省 archived=false → 仅活跃
      .filter((c) => !c.archivedAt)
      .map((c) => c.id);
  }

  private async onFrame(convId: string, f: Frame): Promise<void> {
    if (f.type === "hitl_request") return this.sendCard(convId, f);
    if (f.type !== "hitl_answered") return; // 其余帧不产 IM 出站
    const text = this.render(f);
    if (text !== null) await this.sendToOwner(convId, { text }, `${f.questionId}:${f.type}`);
  }

  /** hitl_request → 交互卡（或用 question 行打素材）；卡不可用/超限 → 回落纯文本。 */
  private async sendCard(convId: string, f: Extract<Frame, { type: "hitl_request" }>): Promise<void> {
    const q = this.deps.store.getQuestion(f.questionId);
    if (!q) return; // 卡已不在（清理/关会话）→ 不追发
    const options: ImCardOption[] = Array.isArray(q.values) && q.values.length > 0
      ? (q.values as { label?: unknown; value?: unknown }[]).map((v) => ({ label: String(v.label ?? ""), value: v.value }))
      : ((q.options as string[]) ?? []).map((label) => ({ label, value: label }));
    const card = renderImCard({ questionId: q.id, kind: (q.kind ?? "ask") as "ask" | "approval" | "task", prompt: q.prompt, options, resumeSchema: q.resumeSchema });
    if (options.length === 0 || cardJsonSize(card) > MAX_CARD_CHARS) {
      const text = renderHitlFrame(f);
      if (text !== null) await this.sendToOwner(convId, { text }, `${f.questionId}:${f.type}`);
      return;
    }
    await this.sendToOwner(convId, { cardJson: card }, `${f.questionId}:${f.type}`);
  }

  private async sendToOwner(convId: string, msg: ImOutboundMessage, uuid: string): Promise<void> {
    const conv = this.deps.store.getConversation(convId);
    if (!conv) return;
    const bound = this.deps.imStore.reverseResolve(conv.userId, this.deps.platform.platform);
    if (!bound) return; // owner 未绑此平台 → 只走 Web/App，不发 IM
    await this.deps.platform.send(bound.imUserId, msg, { uuid })
      .catch((e: unknown) => console.warn(`[im-outbound] ${convId} ${uuid}:`, e instanceof Error ? e.message : e));
  }

  close(): void {
    for (const un of this.unsubs.values()) un();
    this.unsubs.clear();
  }
}