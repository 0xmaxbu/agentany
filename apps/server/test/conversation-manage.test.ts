// #21 / ADR-0020：会话归档与删除后端。归档=软态（archivedAt）可恢复；删除=admin-only 全链清理。
// 权限用真用户（token 落库）——dev 逃生阀默认 dev-user 是 admin，member 场景必须真账号区分。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { WorkspaceStore } from "../src/workspaces/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };
const ADMIN_PW = "pw-admin-1";
const MEMBER_PW = "pw-member-1";

// 真 auth 装配：admin + member 两账号共享一个 db（member 用于 403 与「归档自己的会话」正路径）。
async function makeAuthApp() {
  const db = openDbMigrated(":memory:");
  const store = createStores(db);
  const userStore = new UserStore(db);
  const workspaceStore = new WorkspaceStore(db);
  await userStore.createUser({ username: "root", password: ADMIN_PW, role: "admin" });
  await userStore.createUser({ username: "meme", password: MEMBER_PW, role: "member" });
  const deps: RunDeps = { runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore, workspaceStore, streamRegistry: new StreamRegistry() };
  const app = createApp(deps);
  const tokenOf = async (username: string) => {
    const r = await app.request("/auth/login", {
      method: "POST",
      headers: JH,
      body: JSON.stringify({ username, password: username === "root" ? ADMIN_PW : MEMBER_PW }),
    });
    const b = (await r.json()) as { token: string };
    return b.token;
  };
  return { app, store, tokenOf };
}

const auth = (tok: string) => ({ "content-type": "application/json", authorization: `Bearer ${tok}` });

async function createConv(app: ReturnType<typeof createApp>, tok: string) {
  const r = await app.request("/conversations", { method: "POST", headers: auth(tok), body: JSON.stringify({}) });
  return (await r.json()) as { id: string };
}

describe("#21 归档", () => {
  test("archive → 默认列表消失，?archived=1 可见；POST messages 409；restore 后恢复可发", async () => {
    const { app, tokenOf } = await makeAuthApp();
    const tok = await tokenOf("root");
    const c = await createConv(app, tok);

    // 归档前可发：空 content 400 = 鉴权/存在性/归档关卡都过，只败在 body（对照归档后 409）
    const pre = await app.request(`/conversations/${c.id}/messages`, { method: "POST", headers: auth(tok), body: JSON.stringify({ content: "" }) });
    expect(pre.status).toBe(400);

    const ar = await app.request(`/conversations/${c.id}/archive`, { method: "PATCH", headers: auth(tok) });
    expect(ar.status).toBe(200);
    expect(((await ar.json()) as any).archivedAt).toBeTruthy();

    // 默认列表不含；?archived=1 含
    const live = (await (await app.request("/conversations", { headers: auth(tok) })).json()) as any[];
    expect(live.some((x) => x.id === c.id)).toBe(false);
    const archived = (await (await app.request("/conversations?archived=1", { headers: auth(tok) })).json()) as any[];
    expect(archived.some((x) => x.id === c.id)).toBe(true);

    // 归档可看不可发：GET messages 200；POST 409
    expect((await app.request(`/conversations/${c.id}/messages`, { headers: auth(tok) })).status).toBe(200);
    const post = await app.request(`/conversations/${c.id}/messages`, { method: "POST", headers: auth(tok), body: JSON.stringify({ content: "hi" }) });
    expect(post.status).toBe(409);

    // 恢复 → 列表重现 + 可发（空 content 400 = 过了 409 关卡）
    const rr = await app.request(`/conversations/${c.id}/restore`, { method: "PATCH", headers: auth(tok) });
    expect(rr.status).toBe(200);
    expect(((await rr.json()) as any).archivedAt).toBeNull();
    const live2 = (await (await app.request("/conversations", { headers: auth(tok) })).json()) as any[];
    expect(live2.some((x) => x.id === c.id)).toBe(true);
    const post2 = await app.request(`/conversations/${c.id}/messages`, { method: "POST", headers: auth(tok), body: JSON.stringify({ content: "" }) });
    expect(post2.status).toBe(400);
  });

  test("archive 幂等：重复 archive 不报错；restore 未归档会话也不报错", async () => {
    const { app, tokenOf } = await makeAuthApp();
    const tok = await tokenOf("root");
    const c = await createConv(app, tok);
    expect((await app.request(`/conversations/${c.id}/archive`, { method: "PATCH", headers: auth(tok) })).status).toBe(200);
    expect((await app.request(`/conversations/${c.id}/archive`, { method: "PATCH", headers: auth(tok) })).status).toBe(200);
    expect((await app.request(`/conversations/${c.id}/restore`, { method: "PATCH", headers: auth(tok) })).status).toBe(200);
    expect((await app.request(`/conversations/${c.id}/restore`, { method: "PATCH", headers: auth(tok) })).status).toBe(200);
  });
});

describe("#21 删除（admin-only 全链）", () => {
  test("member DELETE 自己的会话 → 403（非 404）；admin 跨用户删 → 全链清理，runs 仅解绑", async () => {
    const { app, store, tokenOf } = await makeAuthApp();
    const adminTok = await tokenOf("root");
    const memberTok = await tokenOf("meme");

    // member 建会话（创建者可见），DELETE → 403
    const mc = await createConv(app, memberTok);
    const forbidden = await app.request(`/conversations/${mc.id}`, { method: "DELETE", headers: auth(memberTok) });
    expect(forbidden.status).toBe(403);

    // admin 删 member 的会话（跨用户正路径）
    expect((await app.request(`/conversations/${mc.id}`, { method: "DELETE", headers: auth(adminTok) })).status).toBe(200);
    expect((await app.request(`/conversations/${mc.id}`, { headers: auth(adminTok) })).status).toBe(404);

    // 带挂靠数据的会话：message + hitl question + run（绑 conversationId）→ 全链清理
    const c = await createConv(app, adminTok);
    store.chat.appendMessage({ conversationId: c.id, role: "user", content: "m1" });
    store.hitl.createQuestion({ conversationId: c.id, prompt: "q?", options: ["a", "b"] });
    store.runs.createRun({ runId: "run_1", workflowId: "wf", workspaceId: "ws_company", conversationId: c.id, input: {} });
    expect((await app.request(`/conversations/${c.id}`, { method: "DELETE", headers: auth(adminTok) })).status).toBe(200);

    expect(store.chat.getConversation(c.id)).toBeUndefined();
    expect(store.chat.listMessages(c.id)).toEqual([]);
    expect(store.hitl.listQuestions(c.id, { includeAnswered: true })).toEqual([]);
    expect(store.runs.listRunningRunIds(c.id)).toEqual([]); // 解绑后按会话查 run = 空
    const r1 = store.runs.getRun("run_1"); // 域面直读（不再 poke 私有 db）
    expect(r1).toBeTruthy(); // run 本体保留（workspace 资产，ADR-0018）
    expect(r1!.conversationId).toBeNull(); // 仅解绑
  });

  test("DELETE 不存在/已删 → 404", async () => {
    const { app, tokenOf } = await makeAuthApp();
    const tok = await tokenOf("root");
    expect((await app.request("/conversations/nope", { method: "DELETE", headers: auth(tok) })).status).toBe(404);
  });
});
