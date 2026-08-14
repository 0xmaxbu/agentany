// 真 auth + 用户管理（ADR-0014，步骤 a）。覆盖 login/logout/me/开通/注销/改密/重置 + dev 阀回归 + StreamRegistry 单测。
//
// 注意 env：吊销→401 的断言需 AGENTANY_DEV_TOKEN 被设（=prod「auth 强制」态）；
// 否则吊销的 token 会回退 dev 阀（pass-through → dev-user → /me 404）。dev 阀回归测试则必须 unset。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { makeDeps } from "./deps";
import { StreamRegistry } from "../src/chat/stream-registry";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };
const H = (token?: string) => (token ? { authorization: `Bearer ${token}`, ...JH } : { ...JH });

/** 登录拿 token（seed 一个用户先）。 */
async function login(app: ReturnType<typeof createApp>, username: string, password: string): Promise<string> {
  const r = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username, password }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as any).token as string;
}

describe("auth + users", () => {
  let deps: RunDeps;
  beforeEach(() => {
    deps = makeDeps();
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token"; // 默认「auth 强制」态（=prod）：吊销 → 401
  });
  afterEach(() => {
    delete process.env.AGENTANY_DEV_TOKEN; // 防泄漏到同进程其它测试文件（它们依赖 pass-through）
  });

  test("dev 阀回归：无 env 无 header → 建会话 201、userId=dev-user（保现有测试不破）", async () => {
    delete process.env.AGENTANY_DEV_TOKEN; // 此例必须 unset 才能验 pass-through
    const app = createApp(deps);
    const r = await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).userId).toBe("dev-user");
  });

  test("login 成功返 token+user（不含 hash）；坏密码 401", async () => {
    await deps.userStore.createUser({ username: "alice", password: "password1", role: "admin" });
    const app = createApp(deps);
    const ok = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "alice", password: "password1" }) });
    expect(ok.status).toBe(200);
    const body: any = await ok.json();
    expect(typeof body.token).toBe("string");
    expect(body.user.username).toBe("alice");
    expect(body.user.role).toBe("admin");
    expect(body.user).not.toHaveProperty("passwordHash");
    const bad = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "alice", password: "wrongpass" }) });
    expect(bad.status).toBe(401);
    // 不存在用户 → 401（timingSafeVerify：仍跑满一次 argon2 verify，防用户名枚举侧信道）
    const ghost = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "ghost", password: "whatever1" }) });
    expect(ghost.status).toBe(401);
  });

  test("真 token → /me 200；坏 token 401；logout 后原 token 401", async () => {
    await deps.userStore.createUser({ username: "bob", password: "password1" });
    const app = createApp(deps);
    const token = await login(app, "bob", "password1");
    const me = await app.request("/me", { headers: H(token) });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).username).toBe("bob");
    expect((await app.request("/me", { headers: H("at_bogus") })).status).toBe(401);
    expect((await app.request("/auth/logout", { method: "POST", headers: H(token) })).status).toBe(200);
    expect((await app.request("/me", { headers: H(token) })).status).toBe(401);
  });

  test("admin 开通 201 / 重名 409 / member 开通 → 403", async () => {
    await deps.userStore.createUser({ username: "admin", password: "password1", role: "admin" });
    await deps.userStore.createUser({ username: "member", password: "password1", role: "member" });
    const app = createApp(deps);
    const adminTok = await login(app, "admin", "password1");
    const memberTok = await login(app, "member", "password1");
    expect((await app.request("/users", { method: "POST", headers: H(adminTok), body: JSON.stringify({ username: "carol", password: "password1" }) })).status).toBe(201);
    expect((await app.request("/users", { method: "POST", headers: H(adminTok), body: JSON.stringify({ username: "carol", password: "password1" }) })).status).toBe(409);
    expect((await app.request("/users", { method: "POST", headers: H(memberTok), body: JSON.stringify({ username: "dave", password: "password1" }) })).status).toBe(403);
    // list（admin 可见，不含 hash）
    const list = await app.request("/users", { headers: H(adminTok) });
    expect(list.status).toBe(200);
    const arr = (await list.json()) as any[];
    expect(arr.length).toBe(3);
    expect(arr[0]).not.toHaveProperty("passwordHash");
  });

  test("admin 注销：该用户旧 token 失效、login 401", async () => {
    await deps.userStore.createUser({ username: "admin", password: "password1", role: "admin" });
    await deps.userStore.createUser({ username: "eve", password: "password1" });
    const app = createApp(deps);
    const adminTok = await login(app, "admin", "password1");
    const eveTok = await login(app, "eve", "password1");
    const eve = deps.userStore.getUserByUsername("eve")!;
    expect((await app.request(`/users/${eve.id}/deactivate`, { method: "POST", headers: H(adminTok) })).status).toBe(200);
    expect((await app.request("/me", { headers: H(eveTok) })).status).toBe(401);
    expect((await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "eve", password: "password1" }) })).status).toBe(401);
  });

  test("改密：旧密码错 403；成功后其它 token 失效、当前 token 仍有效、新密码可登", async () => {
    await deps.userStore.createUser({ username: "frank", password: "password1" });
    const app = createApp(deps);
    const tokA = await login(app, "frank", "password1");
    const tokB = await login(app, "frank", "password1");
    expect((await app.request("/me/password", { method: "POST", headers: H(tokA), body: JSON.stringify({ currentPassword: "wrongpass", newPassword: "newpass12" }) })).status).toBe(403);
    expect((await app.request("/me/password", { method: "POST", headers: H(tokA), body: JSON.stringify({ currentPassword: "password1", newPassword: "newpass12" }) })).status).toBe(200);
    expect((await app.request("/me", { headers: H(tokA) })).status).toBe(200); // 当前会话保留
    expect((await app.request("/me", { headers: H(tokB) })).status).toBe(401); // 其它设备踢出
    expect((await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "frank", password: "newpass12" }) })).status).toBe(200);
  });

  test("admin 重置密码：旧 token 失效、新密码可登", async () => {
    await deps.userStore.createUser({ username: "admin", password: "password1", role: "admin" });
    await deps.userStore.createUser({ username: "grace", password: "password1" });
    const app = createApp(deps);
    const adminTok = await login(app, "admin", "password1");
    const graceTok = await login(app, "grace", "password1");
    const grace = deps.userStore.getUserByUsername("grace")!;
    expect((await app.request(`/users/${grace.id}/reset-password`, { method: "POST", headers: H(adminTok), body: JSON.stringify({ newPassword: "resetpass1" }) })).status).toBe(200);
    expect((await app.request("/me", { headers: H(graceTok) })).status).toBe(401);
    expect((await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "grace", password: "resetpass1" }) })).status).toBe(200);
  });

  test("校验：短密码 400 / 非法 username 400", async () => {
    await deps.userStore.createUser({ username: "admin", password: "password1", role: "admin" });
    const app = createApp(deps);
    const tok = await login(app, "admin", "password1");
    expect((await app.request("/users", { method: "POST", headers: H(tok), body: JSON.stringify({ username: "x", password: "short" }) })).status).toBe(400);
    expect((await app.request("/users", { method: "POST", headers: H(tok), body: JSON.stringify({ username: "bad name!", password: "password1" }) })).status).toBe(400);
  });
});

describe("StreamRegistry", () => {
  test("abortUser 跑该用户全部 abort + 自动摘除；其它用户不动", () => {
    const sr = new StreamRegistry();
    let aClosed = 0;
    const detachA = sr.attach("u1", () => { aClosed++; });
    let bClosed = 0;
    sr.attach("u1", () => { bClosed++; });
    let cClosed = 0;
    sr.attach("u2", () => { cClosed++; });
    expect(sr.abortUser("u1")).toBe(2);
    expect(aClosed).toBe(1);
    expect(bClosed).toBe(1);
    expect(cClosed).toBe(0); // u2 不动
    detachA(); // 已 abort，detach 幂等无副作用
    expect(sr.abortUser("u1")).toBe(0); // 摘除后无残留
  });
});
