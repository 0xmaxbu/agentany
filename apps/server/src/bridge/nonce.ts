// per-turn bridge nonce（ticket #11）：pi 子进程回调服务端 3199 的 bearer 令牌。
// 单进程内存 Map（重启无残留——符合 #11）。一 nonce 绑一 turn。
//
// 清退（spec 收口）：revokeNonce 即删条目（turn 末 finally 清退 → 正常工况 Map 只留在飞 turn）；
// 另设 cap 兜底，防「崩在 finally 前 / 异常泄漏」导致无界增长——超 cap 淘汰最老（Map 插入序）。
//
// 威胁模型：沙箱放行了 bridge 端口的 loopback（ADR-0012 窄修正），故 bridge 必须自身鉴权——
// per-turn nonce 即此闸。pi 持本 turn 的 nonce 才能调；吊销/淘汰后即便泄露也已失效。

let maxNonces = Number(process.env.BRIDGE_MAX_NONCES ?? 10_000);
const entries = new Map<string, { conversationId: string }>(); // token → 会话（审计用，#12+ 端点日志）

/** 为某会话的当前 turn 签发一个 nonce。返回值经 env 注入 pi 子进程。 */
export function issueNonce(conversationId: string): string {
  if (entries.size >= maxNonces) {
    // 兜底淘汰：Map 插入序首个即最老（issueNonce 追加，与时间单调一致）。
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  const token = globalThis.crypto.randomUUID(); // 122-bit 强随机
  entries.set(token, { conversationId });
  return token;
}

/** bridge 中间件用：token 存在即有效（revoke/淘汰即删除 → 存在=有效未吊销）。 */
export function verifyNonce(token: string): boolean {
  return entries.has(token);
}

/** turn 结束（正常/abort/出错）吊销——直接删条目，正常工况下不留残余。 */
export function revokeNonce(token: string): void {
  entries.delete(token);
}

/** bridge /run/* 用：token → 所属会话（run 的事件推回该会话的持久流）。token 不存在（已吊销/淘汰）→ null。 */
export function nonceConversation(token: string): string | null {
  return entries.get(token)?.conversationId ?? null;
}

// —— 测试用 ——
export function _clearNonces(): void { entries.clear(); }
export function _nonceCount(): number { return entries.size; }
export function _setMaxNonces(n: number): void { maxNonces = n; }
