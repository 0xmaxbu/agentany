// 共享持久化工具（ADR-0030）：单调时间戳 + JSON encode/decode。
// 四域 store（runs/chat/hitl/feedback）共用同一 now()/J/P——单调时钟保证同毫秒连续操作
// 严格先后（updatedAt 倒序锚不退化成插入序；touch「排最前」语义毫秒内也成立）。
export const J = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
export const P = (s: string | null): unknown => (s != null ? JSON.parse(s) : null);

let lastTs = 0;
export const now = (): string => {
  const t = Date.now();
  lastTs = t > lastTs ? t : lastTs + 1;
  return new Date(lastTs).toISOString();
};