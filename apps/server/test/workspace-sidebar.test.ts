// 侧栏手风琴后端（#手风琴 grill 定稿）：ws 活跃度聚合（我的会话）+ 会话分页 + ws 归档。
// 权限用真用户（对齐 user-admin.test 装配）。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { WorkspaceStore } from "../src/workspaces/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { COMPANY_WORKSPACE_ID } from "../src/workspaces/store";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function makeAuthApp() {
  const db = openDbMigrated(":memory:");
  const userStore = new UserStore(db);
  const workspaceStore = new WorkspaceStore(db);
  const store = createStores(db);
  await userStore.createUser({ username: "root", password: "pw-admin-1", role: "admin" });
  await userStore.createUser({ username: "meme", password: "pw-member-1", role: "member" });
  const deps: RunDeps = { runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore, workspaceStore, streamRegistry: new StreamRegistry() };
  const app = createApp(deps);
  const tokenOf = async (username: string) => {
    const r = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username, password: username === "root" ? "pw-admin-1" : "pw-member-1" }) });
    return ((await r.json()) as { token: string }).token;
  };
  return { app, store, workspaceStore, tokenOf };
}

const auth = (tok: string) => ({ "content-type": "application/json", authorization: `Bearer ${tok}` });

const makeConv = (store: Stores, userId: string, workspaceId: string, n: number) => {
  for (let i = 0; i < n; i++) store.chat.createConversation({ id: `c_${workspaceId}_${userId}_${i}`, workspaceId, userId });
};

describe("手风琴 · GET /workspaces 聚合", () => {
  test("lastActiveAt/conversationCount 只算我的会话（跨用户不泄漏）", async () => {
    const { app, store, workspaceStore, tokenOf } = await makeAuthApp();
    const adminTok = await tokenOf("root");
    const admin = (await (await app.request("/me", { headers: auth(adminTok) })).json()) as { id: string };
    const memberTok = await tokenOf("meme");
    const member = (await (await app.request("/me", { headers: auth(memberTok) })).json()) as { id: string };

    // 建 ws（allUsers）——两人都可见；各造不同数量会话
    const ws: any = await (await app.request("/workspaces", { method: "POST", headers: auth(adminTok), body: JSON.stringify({ name: "act", allUsers: true }) })).json() as any[];
    makeConv(store, admin.id, ws.id, 3);
    makeConv(store, member.id, ws.id, 1);

    for (const [tok, expectCount] of [[adminTok, 3], [memberTok, 1]] as const) {
      const list: any[] = await (await app.request("/workspaces", { headers: auth(tok) })).json() as any[];
      const mine = list.find((w) => w.id === ws.id)!;
      expect(mine.conversationCount).toBe(expectCount);
      expect(mine.lastActiveAt).toBeTruthy();
    }
  });
});

describe("手风琴 · GET /conversations 分页", () => {
  test("limit/offset 按 updatedAt 倒序切片；无参全量（搜索兜底）", async () => {
    const { app, store, tokenOf } = await makeAuthApp();
    const tok = await tokenOf("root");
    const me = (await (await app.request("/me", { headers: auth(tok) })).json()) as { id: string };
    makeConv(store, me.id, COMPANY_WORKSPACE_ID, 15); // updatedAt 同毫秒？——createConversation 用 now()，补 touch 打散

    const p1: any[] = await (await app.request(`/conversations?limit=10`, { headers: auth(tok) })).json() as any[];
    expect(p1.length).toBe(10);
    const p2: any[] = await (await app.request(`/conversations?limit=10&offset=10`, { headers: auth(tok) })).json() as any[];
    expect(p2.length).toBe(5);
    // 无重叠 + 全量 = 两页并集
    const full: any[] = await (await app.request("/conversations", { headers: auth(tok) })).json() as any[];
    expect(full.length).toBeGreaterThanOrEqual(15);
    expect(new Set([...p1, ...p2].map((c) => c.id)).size).toBe(15);
    // 按 ws 过滤 + 分页组合
    const byWs: any[] = await (await app.request(`/conversations?workspaceId=${COMPANY_WORKSPACE_ID}&limit=10`, { headers: auth(tok) })).json() as any[];
    expect(byWs.every((c) => c.workspaceId === COMPANY_WORKSPACE_ID)).toBe(true);
  });
});

describe("手风琴 · ws 归档", () => {
  test("member 403；admin archive → GET /workspaces 默认滤掉、?archived=1 可见、restore 复原", async () => {
    const { app, tokenOf } = await makeAuthApp();
    const adminTok = await tokenOf("root");
    const memberTok = await tokenOf("meme");
    const ws: any = await (await app.request("/workspaces", { method: "POST", headers: auth(adminTok), body: JSON.stringify({ name: "archme", allUsers: true }) })).json() as any[];

    expect((await app.request(`/workspaces/${ws.id}/archive`, { method: "PATCH", headers: auth(memberTok) })).status).toBe(403);

    expect((await app.request(`/workspaces/${ws.id}/archive`, { method: "PATCH", headers: auth(adminTok) })).status).toBe(200);
    let list: any[] = await (await app.request("/workspaces", { headers: auth(adminTok) })).json() as any[];
    expect(list.some((w) => w.id === ws.id)).toBe(false);
    list = await (await app.request("/workspaces?archived=1", { headers: auth(adminTok) })).json() as any[];
    expect(list.some((w) => w.id === ws.id)).toBe(true);

    expect((await app.request(`/workspaces/${ws.id}/restore`, { method: "PATCH", headers: auth(adminTok) })).status).toBe(200);
    list = await (await app.request("/workspaces", { headers: auth(adminTok) })).json() as any[];
    expect(list.some((w) => w.id === ws.id)).toBe(true);
  });

  test("归档 ws 的会话可看可发（非封禁——admin 整理动作）", async () => {
    const { app, store, tokenOf } = await makeAuthApp();
    const adminTok = await tokenOf("root");
    const me = (await (await app.request("/me", { headers: auth(adminTok) })).json()) as { id: string };
    const ws: any = await (await app.request("/workspaces", { method: "POST", headers: auth(adminTok), body: JSON.stringify({ name: "archsend", allUsers: true }) })).json() as any[];
    const conv = store.chat.createConversation({ id: "c_archsend_1", workspaceId: ws.id, userId: me.id });
    await app.request(`/workspaces/${ws.id}/archive`, { method: "PATCH", headers: auth(adminTok) });

    // GET messages 200（可看）
    expect((await app.request(`/conversations/${conv.id}/messages`, { headers: auth(adminTok) })).status).toBe(200);
    // POST messages 不 409（可发——区别于会话归档；空 content 400 = 过了所有关卡只败 body）
    const r = await app.request(`/conversations/${conv.id}/messages`, { method: "POST", headers: auth(adminTok), body: JSON.stringify({ content: "" }) });
    expect(r.status).toBe(400);
  });

  test("公司 ws 不可归档（400）", async () => {
    const { app, tokenOf } = await makeAuthApp();
    const tok = await tokenOf("root");
    expect((await app.request(`/workspaces/${COMPANY_WORKSPACE_ID}/archive`, { method: "PATCH", headers: auth(tok) })).status).toBe(400);
  });
});
