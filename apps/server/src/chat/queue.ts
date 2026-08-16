// per-conversation FIFO（ADR-0009 BE-Q2；ticket #13 重构两类入队）。
// 同一会话严格串行（保 pi session 不被并发写坏）；不同会话并行。单进程 → 纯内存。
//
// 两类 turn 共享【同一条】FIFO 链（tails）→ pi session 串行：
// - enqueueHttpTurn（用户消息）：同步 429（pending > MAX_HTTP）。
// - enqueueEventTurn（run_* 自动 turn，#15）：无 429、内部 cap 防风暴。
const MAX_HTTP_PENDING = Number(process.env.CHAT_MAX_PENDING ?? 5);
const MAX_EVENT_PENDING = Number(process.env.CHAT_MAX_EVENT_PENDING ?? 3);

export class ConversationQueues {
  private tails = new Map<string, Promise<void>>();     // 每会话 FIFO 链尾（串行靠 prev.then）
  private httpPending = new Map<string, number>();      // HTTP turn 计数（含在跑）→ 429
  private eventPending = new Map<string, number>();     // 事件 turn 计数 → 防风暴
  private active = new Map<string, AbortController>();  // 当前在跑 turn 的控制器（abort）

  /** HTTP turn（用户消息）：同步 429 检查 + 入 FIFO。满 → false（路由回 429）。 */
  enqueueHttpTurn(conversationId: string, run: (signal: AbortSignal) => Promise<void>): boolean {
    return this.enqueueCapped(conversationId, run, this.httpPending, MAX_HTTP_PENDING);
  }

  /** 只读预检：再入一条 HTTP turn 是否被接受（pending+1 ≤ MAX）。POST /messages 据此同步判 429（不入队、不改计数）。 */
  wouldAcceptHttpTurn(conversationId: string): boolean {
    return (this.httpPending.get(conversationId) ?? 0) + 1 <= MAX_HTTP_PENDING;
  }

  /** 事件 turn（run_* 自动 turn，#15）：无 429、内部 cap 防风暴。超 cap → false（丢弃）。 */
  enqueueEventTurn(conversationId: string, run: (signal: AbortSignal) => Promise<void>): boolean {
    return this.enqueueCapped(conversationId, run, this.eventPending, MAX_EVENT_PENDING);
  }

  // 计数 cap + 入 FIFO（两类 turn 共用；差异仅 counter map 与 cap 阈值——抽此去重）。
  private enqueueCapped(conversationId: string, run: (s: AbortSignal) => Promise<void>, counter: Map<string, number>, cap: number): boolean {
    const n = (counter.get(conversationId) ?? 0) + 1;
    if (n > cap) return false;
    counter.set(conversationId, n);
    this.chain(conversationId, run, counter);
    return true;
  }

  // 入 FIFO 链尾；轮到时拿专属 AbortSignal；finally 减对应计数器。错误不 poison 链。
  private chain(
    conversationId: string,
    run: (s: AbortSignal) => Promise<void>,
    counter: Map<string, number>,
  ): void {
    const prev = this.tails.get(conversationId) ?? Promise.resolve();
    const tail = prev.then(async () => {
      const ac = new AbortController();
      this.active.set(conversationId, ac);
      try {
        await run(ac.signal);
      } finally {
        this.active.delete(conversationId);
        const left = (counter.get(conversationId) ?? 1) - 1;
        if (left <= 0) counter.delete(conversationId);
        else counter.set(conversationId, left);
      }
    });
    this.tails.set(conversationId, tail.catch(() => {}));
  }

  /** 当前链尾 promise（#29 定时任务用）：resolve = 已入队的 turn 全部跑完。空链立即 resolve。
   *  拿的是快照——之后新入队的 turn 不含在内（executeTask 的 finishRun 等快照即可）。 */
  drained(conversationId: string): Promise<void> {
    return this.tails.get(conversationId) ?? Promise.resolve();
  }

  /** abort 当前在跑 turn（无论 HTTP/事件来源）。无在跑 → false。 */
  abort(conversationId: string): boolean {
    const ac = this.active.get(conversationId);
    if (ac) {
      ac.abort();
      return true;
    }
    return false;
  }
}
