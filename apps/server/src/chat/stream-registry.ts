// 活跃 SSE 流登记（按 userId）：token 吊销（注销/改密/重置）时强断已开的长连。
// 只断 SSE——run 经 EventBus/turn 独立跑完（不杀 run、不丢 LLM 输出；见 conversations.ts /stream）。
export class StreamRegistry {
  private byUser = new Map<string, Set<() => void>>();

  /** 连上时注册一个 abort（幂等）；返回 detach（正常结束/客户端断开时调，防泄漏）。 */
  attach(userId: string, abort: () => void): () => void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(abort);
    return () => {
      const s = this.byUser.get(userId);
      if (!s) return;
      s.delete(abort);
      if (s.size === 0) this.byUser.delete(userId);
    };
  }

  /** 吊销：跑该用户全部 abort（断 SSE）。返回断开数。 */
  abortUser(userId: string): number {
    const set = this.byUser.get(userId);
    if (!set) return 0;
    const n = set.size;
    this.byUser.delete(userId); // 先摘，防 abort 内部触发迭代
    for (const a of set) {
      try {
        a();
      } catch {
        /* 单条断开失败不影响其它 */
      }
    }
    return n;
  }
}
