// per-turn bridge nonce（ticket #11）：pi 子进程回调服务端 3199 的 bearer 令牌。
// 单进程内存 Map（重启无残留——符合 #11）。一 nonce 绑一 turn。
//
// 清退（spec 收口）：revokeNonce 即删条目（turn 末 finally 清退 → 正常工况 Map 只留在飞 turn）；
// 另设 cap 兜底，防「崩在 finally 前 / 异常泄漏」导致无界增长——超 cap 淘汰最老（Map 插入序）。
//
// 威胁模型：沙箱放行了 bridge 端口的 loopback（ADR-0012 窄修正），故 bridge 必须自身鉴权——
// per-turn nonce 即此闸。pi 持本 turn 的 nonce 才能调；吊销/淘汰后即便泄露也已失效。

let maxNonces = Number(process.env.BRIDGE_MAX_NONCES ?? 10_000);
const entries = new Map<string, Entry>(); // token → 会话（审计用，#12+ 端点日志）| R-5 加 runId（远端工具 stub）
type Entry = { conversationId: string; runId?: string };

/** 为某会话的当前 turn 签发一个 nonce。返回值经 env 注入 pi 子进程。 */
export function issueNonce(conversationId: string): string {
  const token = globalThis.crypto.randomUUID(); // 122-bit 强随机
  setEntry(token, { conversationId });
  return token;
}

/**
 * 为某 run 签发**跨 turn 长寿 nonce**（ADR-0033/R-5）：远端工具 stub（pi 子进程内）调 bridge /run/remote-tool
 * 的凭据——run 生命周期与 per-turn 无关（detached 后台长跑），故不能用 per-turn nonce（turn 末即吊销）。
 * 同 cap 淘汰兜底（插入序最老优先）；run 终态后可主动 revokeRunNonce 清退。
 */
export function issueRunNonce(runId: string, conversationId: string): string {
  const token = globalThis.crypto.randomUUID();
  setEntry(token, { conversationId, runId });
  return token;
}

/** run 专用 nonce 的映射读：token → {runId, conversationId}（非 run nonce → null）。 */
export function nonceRun(token: string): { runId: string; conversationId: string } | null {
  const e = entries.get(token);
  return e?.runId ? { runId: e.runId, conversationId: e.conversationId } : null;
}

function setEntry(token: string, e: Entry): void {
  if (entries.size >= maxNonces) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(token, e);
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
