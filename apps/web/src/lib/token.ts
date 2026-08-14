// token 存取（f2）：唯一 localStorage 依赖点（旧 agentany.chat.v1 会话持久化已废）。
export const TOKEN_KEY = "agentany.token.v1";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // 无 localStorage 环境（SSR/隐私模式）——视为未登录
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 忽略——token 仅内存生效（本会话可用） */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 忽略 */
  }
}
