// store/auth（f2）：bootstrap 三态 + login/logout/forceLogout + 401 拦截——mock globalThis.fetch。
import { describe, test, expect, beforeEach } from "bun:test";
import { useAuth } from "../src/store/auth";
import { getToken } from "../src/lib/token";
import { apiFetch } from "../src/api";

// bun test 无 DOM——最小 localStorage polyfill（内存 Map 语义）。
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  } as Storage;
}

// fetch mock：按 (method, path) 路由到 {status, body}。
let routes: Record<string, { status: number; body: unknown }> = {};
const calls: { path: string; auth?: string | null }[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  routes = {};
  calls.length = 0;
  localStorage.clear();
  useAuth.setState({ status: "checking", user: null });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    calls.push({ path: key, auth: (init?.headers as Record<string, string>)?.Authorization ?? null });
    const r = routes[key] ?? { status: 404, body: { error: "no route" } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
// 还原（避免污染 sse.test 等其它文件）
process.on("beforeExit", () => {
  globalThis.fetch = realFetch;
});

const me = (status: number, body: unknown = { id: "u1", username: "max", displayName: "Max", role: "member", status: "active", createdAt: "t" }) => {
  routes[`GET /me`] = { status, body };
};

describe("auth bootstrap 三态", () => {
  test("无 token + /me 200（dev 放行）→ anonymous（e2e/本地 dev 直进 chat）", async () => {
    me(200);
    await useAuth.getState().bootstrap();
    expect(useAuth.getState().status).toBe("anonymous");
    expect(useAuth.getState().user?.id).toBe("u1");
  });

  test("无 token + /me 401（真部署）→ unauthenticated", async () => {
    me(401, { error: "unauthorized" });
    await useAuth.getState().bootstrap();
    expect(useAuth.getState().status).toBe("unauthenticated");
  });

  test("有 token + /me 200 → authenticated", async () => {
    localStorage.setItem("agentany.token.v1", "tok_ok");
    me(200);
    await useAuth.getState().bootstrap();
    expect(useAuth.getState().status).toBe("authenticated");
    expect(calls[0].auth).toBe("Bearer tok_ok");
  });

  test("有 token + /me 401（吊销）→ 清 token → 无 token 探测 /me 200 → anonymous", async () => {
    localStorage.setItem("agentany.token.v1", "tok_dead");
    // 第一次（带 token）401，第二次（无 token）dev 放行 200
    let n = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      calls.push({ path: `GET ${url}`, auth });
      n++;
      if (auth) return new Response('{"error":"unauthorized"}', { status: 401 });
      return new Response(JSON.stringify({ id: "dev", username: "dev", role: "admin", status: "active", createdAt: "t" }), { status: 200 });
    }) as typeof fetch;
    await useAuth.getState().bootstrap();
    expect(getToken()).toBeNull(); // 死 token 已清
    expect(useAuth.getState().status).toBe("anonymous");
    expect(n).toBe(2);
  });
});

describe("login/logout/forceLogout", () => {
  test("login 200 → 存 token + authenticated", async () => {
    routes[`POST /auth/login`] = { status: 200, body: { token: "tok_new", user: { id: "u1", username: "max", displayName: "Max", role: "member", status: "active", createdAt: "t" } } };
    const r = await useAuth.getState().login("max", "password1");
    expect(r.ok).toBe(true);
    expect(getToken()).toBe("tok_new");
    expect(useAuth.getState().status).toBe("authenticated");
  });

  test("login 401 → {ok:false} 内联错误、状态不变、无 token", async () => {
    routes[`POST /auth/login`] = { status: 401, body: { error: "invalid credentials" } };
    const r = await useAuth.getState().login("max", "wrong");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(getToken()).toBeNull();
    expect(useAuth.getState().status).not.toBe("authenticated");
  });

  test("forceLogout → 清 token + unauthenticated（不调后端）", () => {
    localStorage.setItem("agentany.token.v1", "tok_x");
    useAuth.setState({ status: "authenticated" });
    useAuth.getState().forceLogout();
    expect(getToken()).toBeNull();
    expect(useAuth.getState().status).toBe("unauthenticated");
  });

  test("logout：POST /auth/logout 容错（失败也清本地）", async () => {
    localStorage.setItem("agentany.token.v1", "tok_x");
    routes[`POST /auth/logout`] = { status: 500, body: {} };
    await useAuth.getState().logout();
    expect(getToken()).toBeNull();
    expect(useAuth.getState().status).toBe("unauthenticated");
  });
});

describe("apiFetch 401 拦截", () => {
  test("业务请求 401 → forceLogout（状态变 unauthenticated）+ throw", async () => {
    useAuth.setState({ status: "authenticated" });
    routes[`GET /conversations`] = { status: 401, body: { error: "unauthorized" } };
    let threw = "";
    try {
      await apiFetch("/conversations");
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toBeTruthy();
    expect(useAuth.getState().status).toBe("unauthenticated"); // 被 401 拦截踢出
    expect(getToken()).toBeNull();
  });

  test("login 请求自身 401 不触发 forceLogout（登录页内联处理）", async () => {
    useAuth.setState({ status: "unauthenticated" });
    routes[`POST /auth/login`] = { status: 401, body: { error: "invalid credentials" } };
    const r = await apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ username: "a", password: "b" }) });
    expect(r.status).toBe(401); // resolve 返回 Response（由 login() 判 !r.ok 内联报错）
    expect(useAuth.getState().status).toBe("unauthenticated"); // 不变（无副作用循环）
  });

  test("带 token 自动注入 Authorization", async () => {
    localStorage.setItem("agentany.token.v1", "tok_a");
    routes[`GET /conversations`] = { status: 200, body: [] };
    await apiFetch("/conversations");
    expect(calls.at(-1)?.auth).toBe("Bearer tok_a");
  });
});
