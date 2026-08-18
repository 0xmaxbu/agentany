// IM 出站路由胶水（spec #55/T1）：EventBus 帧 →「会话 owner 的绑定 → 该平台的 IM 身份」→ 平台 send。
// 这是 #49「一帧多端」里 IM 那端的收件人解析：卡帧（hitl_request/answered）在会话 c1 出现，
// Web 走 SSE 显卡、IM 走这里发给 c1.owner 绑定的 open_id。订阅按「已绑定用户的活动会话」建立，
// 绑定变更（自助绑定 T5）后重扫 subscribeAll() 即可（幂等）。
// 渲染仍走 renderHitlFrame（平台无关纯函数）；卡片形态 T3 起替换 text。
import type { Frame } from "../chat/eventbus";
import { EventBus } from "../chat/eventbus";
import type { WorkflowStore } from "../workflow-engine/store";
import { ImStore } from "./store";
import { renderHitlFrame } from "./outbound";
import type { IMPlatform } from "./transport";

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
    const text = this.render(f);
    if (text == null) return; // 非 hitl 帧不产 IM 文本
    if (f.type !== "hitl_request" && f.type !== "hitl_answered") return; // 窄化取 questionId（守卫已在 render 之上）
    const conv = this.deps.store.getConversation(convId);
    if (!conv) return;
    const bound = this.deps.imStore.reverseResolve(conv.userId, this.deps.platform.platform);
    if (!bound) return; // owner 未绑此平台 → 只走 Web/App，不发 IM
    await this.deps.platform
      .send(bound.imUserId, { text }, { uuid: `${f.questionId}:${f.type}` })
      .catch((e: unknown) => console.warn(`[im-outbound] ${convId} ${f.type}:`, e instanceof Error ? e.message : e));
  }

  close(): void {
    for (const un of this.unsubs.values()) un();
    this.unsubs.clear();
  }
}