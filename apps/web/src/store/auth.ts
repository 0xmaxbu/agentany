// auth store（f2 拆分①）：身份四态 + login/logout/forceLogout。
// anonymous = 无 token 且后端 dev 放行（/me 200）——e2e 与本地 dev 直进 chat，登录页不挡。
import { create } from "zustand";
import { apiFetch, setOnUnauthorized } from "../api";
import { clearToken, getToken, setToken } from "../lib/token";
import { useChat } from "./chat";

// 角色（#21：判 === 统一引常量，不落字面量；与后端 auth/store.ts ROLE 同形）。
export const ROLE = { admin: "admin", member: "member" } as const;
export type Role = keyof typeof ROLE;

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
  status: string;
  createdAt: string;
}

export type AuthStatus = "checking" | "anonymous" | "authenticated" | "unauthenticated";

interface AuthState {
  status: AuthStatus;
  user: User | null;
  /** 应用启动调一次：有 token 验 /me；无 token 探测 dev 放行（200→anonymous）。 */
  bootstrap: () => Promise<void>;
  /** 登录：200 存 token；401 返 {ok:false, error} 由登录页内联展示（不跳转）。 */
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  /** 登出：POST /auth/logout（容错）→ 清本地。 */
  logout: () => Promise<void>;
  /** 401 拦截用：只清本地（apiFetch 调，不 fetch）。 */
  forceLogout: () => void;
}

import { msg } from "../lib/msg";

export const useAuth = create<AuthState>((set) => ({
  status: "checking",
  user: null,

  bootstrap: async () => {
    // 探测一轮：带 token（有则）→ 401 清 token 再探一轮（无 token）。
    // 直接 fetch 不走 apiFetch——探测的 401 是预期业务结果，不能被 401 拦截 forceLogout。
    for (let round = 0; round < 2; round++) {
      const token = getToken();
      try {
        const r = await fetch("/me", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (r.ok) {
          set({ status: token ? "authenticated" : "anonymous", user: await r.json() });
          return;
        }
        if (r.status === 401) {
          if (token) {
            clearToken(); // 死 token → 落无 token 再探（dev 放行则 anonymous）
            continue;
          }
          set({ status: "unauthenticated", user: null }); // 真部署：未登录
          return;
        }
        set({ status: "unauthenticated", user: null }); // 其它状态码保守按未登录
        return;
      } catch (e) {
        // 网络错（后端未起）：不锁死在 checking——按未登录走（登录页可重试）
        console.warn("bootstrap /me failed:", msg(e));
        set({ status: "unauthenticated", user: null });
        return;
      }
    }
    set({ status: "unauthenticated", user: null });
  },

  login: async (username, password) => {
    try {
      const r = await apiFetch("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      if (!r.ok) return { ok: false, error: r.status === 401 ? "用户名或密码错误" : `登录失败 (${r.status})` };
      const data = (await r.json()) as { token: string; user: User };
      setToken(data.token);
      set({ status: "authenticated", user: data.user });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `网络错误：${msg(e)}` };
    }
  },

  logout: async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" }); // 容错：失败也清本地
    } catch {
      /* 已 401 拦截（forceLogout 已清）或网络错——继续 */
    }
    useChat.getState().closeStream(); // 断持久流（controller 在 store 不在组件，须显式关）
    clearToken();
    set({ status: "unauthenticated", user: null });
  },

  forceLogout: () => {
    useChat.getState().closeStream();
    clearToken();
    set({ status: "unauthenticated", user: null });
  },
}));

// api 层 401 拦截回调注册（apiFetch 不 import 本 store——防循环依赖）
setOnUnauthorized(() => useAuth.getState().forceLogout());
