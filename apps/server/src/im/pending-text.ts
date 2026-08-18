// 选择卡待确认文本缓存（spec #55/T6 #61）：多张 pending ask 卡并存时，文本漂流到「选择卡」——这句文本
// 挂起等用户点选目标卡。键=imUserId；TTL 10min；新文本覆盖（覆盖后由调用方重发选择卡）。
// 实例由 index/测试装配（同一实例贯穿 入站缓存 与 卡回调消费 两个边）。
export const PENDING_TEXT_TTL_MS = 10 * 60 * 1000;

export interface PendingTextCache {
  set(imUserId: string, text: string): void;
  /** 无/已过期 → undefined（过期即清）。 */
  get(imUserId: string): string | undefined;
  del(imUserId: string): void;
}

export function makePendingTextCache(ttlMs: number = PENDING_TEXT_TTL_MS, now: () => number = Date.now): PendingTextCache {
  const m = new Map<string, { text: string; at: number }>();
  return {
    set(imUserId, text) { m.set(imUserId, { text, at: now() }); }, // 覆盖语义 = Map.set
    get(imUserId) {
      const v = m.get(imUserId);
      if (!v) return undefined;
      if (now() - v.at > ttlMs) { m.delete(imUserId); return undefined; }
      return v.text;
    },
    del(imUserId) { m.delete(imUserId); },
  };
}