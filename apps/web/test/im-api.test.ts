// api 层 IM 绑定封装（#62）：issueBindCode / listImBindings / unbindIm — mock fetch 验 URL/方法/载荷/解构，
// 与 server 端 /im 路由契约对齐（POST /im/bind-codes 发码；GET /im/bindings admin 列表；DELETE 兜底解绑）。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { issueBindCode, listImBindings, unbindIm } from "../src/api";

// bun test 无 DOM——最小 localStorage polyfill（auth.test 同款）。
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  } as Storage;
}

let calls: { method: string; path: string; init?: RequestInit }[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path, init });
    if (path === "/im/bind-codes") return new Response(JSON.stringify({ code: "4821", expiresAt: "2026-08-18T13:00:00.000Z", ttlSeconds: 600 }), { status: 200 });
    if (path === "/im/bindings") return new Response(JSON.stringify({ bindings: [{ imUserId: "ou_x", platform: "feishu", userId: "u_1", createdAt: "2026-08-18T12:00:00.000Z" }] }), { status: 200 });
    if (path.startsWith("/im/bindings/")) return new Response(JSON.stringify({ unbound: true }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("issueBindCode（自助发码）", () => {
  test("POST /im/bind-codes → {code, expiresAt, ttlSeconds}", async () => {
    const d = await issueBindCode();
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/im/bind-codes");
    expect(d.code).toBe("4821");
    expect(d.ttlSeconds).toBe(600);
  });
});

describe("listImBindings（admin 绑定列表）", () => {
  test("GET /im/bindings → ImBinding[]（解结构 bindings 数组）", async () => {
    const bs = await listImBindings();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/im/bindings");
    expect(bs).toHaveLength(1);
    expect(bs[0]).toMatchObject({ imUserId: "ou_x", platform: "feishu", userId: "u_1" });
  });
});

describe("unbindIm（admin 兜底解绑）", () => {
  test("DELETE /im/bindings/:platform/:imUserId（URL 编码平台/open_id）", async () => {
    await unbindIm("feishu", "ou_abc/def");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].path).toBe("/im/bindings/feishu/ou_abc%2Fdef"); // encodeURIComponent
  });
});