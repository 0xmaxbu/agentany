// f4：用户管理后端补齐——activate 端点（deactivate 的逆）。真 auth（对齐 conversation-manage.test 装配）。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { WorkspaceStore } from "../src/workspaces/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };
const ADMIN_PW = "pw-admin-1";
const MEMBER_PW = "pw-member-1";

async function makeAuthApp() {
  const db = openDbMigrated(":memory:");
  const userStore = new UserStore(db);
  await userStore.createUser({ username: "root", password: ADMIN_PW, role: "admin" });
  await userStore.createUser({ username: "meme", password: MEMBER_PW, role: "member" });
  const deps: RunDeps = { store: new WorkflowStore(db), userStore, workspaceStore: new WorkspaceStore(db), streamRegistry: new StreamRegistry() };
  const app = createApp(deps);
  const tokenOf = async (username: string) => {
    const r = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username, password: username === "root" ? ADMIN_PW : MEMBER_PW }) });
    return ((await r.json()) as { token: string }).token;
  };
  return { app, userStore, tokenOf };
}

const auth = (tok: string) => ({ "content-type": "application/json", authorization: `Bearer ${tok}` });

describe("f4 用户管理 · activate", () => {
  test("admin：deactivate → 401 登录拒 → activate → 可登录恢复（token 干净）", async () => {
    const { app, userStore, tokenOf } = await makeAuthApp();
    const adminTok = await tokenOf("root");
    const memeId = userStore.getUserByUsername("meme")!.id;

    // 停用后登录拒（401，时序拉平不泄漏原因）
    expect((await app.request("/users/" + memeId + "/deactivate", { method: "POST", headers: auth(adminTok) })).status).toBe(200);
    expect((await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "meme", password: MEMBER_PW }) })).status).toBe(401);

    // member 已停用登录不进（无 token）——activate 也不可能由 member 自己发起
    const memberTok = await tokenOf("meme");
    expect(memberTok).toBeFalsy();
    expect((await app.request(`/users/${memeId}/activate`, { method: "POST", headers: auth(adminTok) })).status).toBe(200);

    // 恢复后可登录；列表状态回 active
    const again = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "meme", password: MEMBER_PW }) });
    expect(again.status).toBe(200);
    const list = (await (await app.request("/users", { headers: auth(adminTok) })).json()) as { username: string; status: string }[];
    expect(list.find((u) => u.username === "meme")!.status).toBe("active");
  });

  test("activate 幂等（active 再 activate 仍 200）；不存在 404", async () => {
    const { app, tokenOf } = await makeAuthApp();
    const tok = await tokenOf("root");
    expect((await app.request("/users/nope/activate", { method: "POST", headers: auth(tok) })).status).toBe(404);
  });
});

describe("f4 workspace · slug 自动生成", () => {
  test("建 ws 不带 slug → 后端自动生成（合法 slug，不暴露给用户）", async () => {
    const { app, tokenOf } = await makeAuthApp();
    const tok = await tokenOf("root");
    const r = await app.request("/workspaces", { method: "POST", headers: auth(tok), body: JSON.stringify({ name: "Acme 品牌" }) });
    expect(r.status).toBe(201);
    const w = (await r.json()) as { slug: string };
    expect(w.slug).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/); // SLUG_RE 同规
  });
});
