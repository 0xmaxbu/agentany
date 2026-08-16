// #34 消息级反馈锚对齐（纯函数）：pi session 历史（id=entry id）与 DB messages（id=自增）双源对齐。
// 背景：消息级 feedback 的 targetId 必须是 DB messages.id（conversationIdOfMessage 权限反查 +
// 蒸馏重入队都查 DB）；pi 源历史只有 entry id → 对齐后把 dbId 附在 HistoryMessage 上。
// 算法：(role, content) 相等 + 双指针贪心（pi 侧可能多出 error/aborted 轮——DB 未落，跳过继续对齐）。
export interface AlignHist {
  id: string;
  role: "user" | "assistant";
  content: string;
  dbId?: number | null;
}
export interface AlignDb {
  id: number | string;
  role: string;
  content: string;
}

export function alignDbIds<T extends AlignHist>(hist: T[], db: AlignDb[]): (T & { dbId: number | null })[] {
  let j = 0; // DB 游标（单调前进——历史有序）
  return hist.map((h) => {
    // 从当前游标向后找首个 (role, content) 全等（贪心：跨过不匹配的 DB 行只会发生在 DB 侧多出时——
    // DB 不会多于 pi 源（appendMessage 只在 user 进来/assistant 干净结束时写），找不到即 dbId=null）
    for (let k = j; k < db.length; k++) {
      if (db[k].role === h.role && db[k].content === h.content) {
        j = k + 1;
        return { ...h, dbId: Number(db[k].id) };
      }
    }
    return { ...h, dbId: null };
  });
}
