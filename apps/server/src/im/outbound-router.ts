// IM 出站路由胶水（spec #55/T1+T3）：EventBus 帧 →「会话 owner 的绑定 → 该平台的 IM 身份」→ 平台 adapter。
// T3（#58）：hitl_request → 交互卡片（领域模型 → adapter 渲染）；hitl_answered → 确认回执文本。
// ADR-0032：走 ImPlatformAdapter + sendCardGuarded（optionless/超限守卫与 backfill 同源）——本文件只学 chat+hitl 面。
// 订阅按「已绑定用户的活动会话」建立，绑定变更（自助绑定 T5）后重扫 subscribeAll() 即可（幂等）。
// uuid 派生 `${questionId}:${frame.type}`：平台层幂等键（飞书 1h 去重窗）——瞬时故障重试不双发卡/回执。
import type { Frame } from "../chat/eventbus";
import { EventBus } from "../chat/eventbus";
import type { ChatStore } from "../chat/store"; // ADR-0030：出站路由只学 chat+hitl 面
import type { HitlStore } from "../hitl/store";
import { ImStore } from "./store";
import { renderHitlFrame, sendCardGuarded } from "./deliver";
import { cardInputOf } from "./card-model";
import type { ImPlatformAdapter } from "./types";

export interface OutboundRouterDeps {
  chatStore: ChatStore;
  hitlStore: HitlStore;
  imStore: ImStore;
  bus: EventBus;
  platform: ImPlatformAdapter;
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
    return this.deps.chatStore.listConversations(userId) // 缺省 archived=false → 仅活跃
      .filter((c) => !c.archivedAt)
      .map((c) => c.id);
  }

  private async onFrame(convId: string, f: Frame): Promise<void> {
    if (f.type === "hitl_request") return this.sendCard(convId, f);
    if (f.type !== "hitl_answered") return; // 其余帧不产 IM 出站
    const text = this.render(f);
    if (text !== null) await this.sendToOwner(convId, (to) => this.deps.platform.sendText(to, text, { uuid: `${f.questionId}:${f.type}` }));
  }

  /** hitl_request → 交互卡（领域模型）；optionless 守卫由 sendCardGuarded 兜底发送文本。 */
  private async sendCard(convId: string, f: Extract<Frame, { type: "hitl_request" }>): Promise<void> {
    const q = this.deps.hitlStore.getQuestion(f.questionId);
    if (!q) return; // 卡已不在（清理/关会话）→ 不追发
    await this.sendToOwner(convId, (to) =>
      sendCardGuarded(this.deps.platform, to, cardInputOf(q), { uuid: `${f.questionId}:${f.type}` }));
  }

  private async sendToOwner(convId: string, send: (to: string) => Promise<void>): Promise<void> {
    const conv = this.deps.chatStore.getConversation(convId);
    if (!conv) return;
    const bound = this.deps.imStore.reverseResolve(conv.userId, this.deps.platform.platform);
    if (!bound) return; // owner 未绑此平台 → 只走 Web/App，不发 IM
    await send(bound.imUserId)
      .catch((e: unknown) => console.warn(`[im-outbound] ${convId}:`, e instanceof Error ? e.message : e));
  }

  close(): void {
    for (const un of this.unsubs.values()) un();
    this.unsubs.clear();
  }
}