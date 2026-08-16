// #34/M5-1 反馈面 HTTP seam：两粒度（消息级 👍/👎 + run 级批注评分）+ 放宽校验 + 权限（会话可见性 404）。
// 覆盖 ADR-0008 老用例语义（多态 POST/GET、rating 越界）；「缺 text→400」随放宽改为「text/rating 全缺→400」。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };

async function setup() {
  const db = openDbMigrated(":memory:");
  const store = new WorkflowStore(db);
  const userStore = new UserStore(db);
  await userStore.createUser({ username: "m1", password: "pw-long-enough", role: "member" });
  const m1 = userStore.getUserByUsername("m1")!;
  await userStore.createUser({ username: "m2", password: "pw-long-enough", role: "member" });
  const m2 = userStore.getUserByUsername("m2")!;
  await userStore.createUser({ username: "ad", password: "pw-long-enough", role: "admin" });
  const deps: RunDeps = {
    store, userStore, streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store),
    eventBus: new EventBus(),
  };
  const app = createApp(deps);
  const login = async (u: string) => {
    const r = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: u, password: "pw-long-enough" }) });
    return `Bearer ${(await r.json() as any).token}`;
  };
  // m1 的会话+消息（消息级挂它）；m2 的会话+消息（他人 404 用）
  const c1 = store.createConversation({ id: "c_m1", workspaceId: "ws_company", userId: m1.id });
  const msgId = store.appendMessage({ conversationId: c1.id, role: "assistant", content: "回答" });
  const c2 = store.createConversation({ id: "c_m2", workspaceId: "ws_company", userId: m2.id });
  const msg2Id = store.appendMessage({ conversationId: c2.id, role: "assistant", content: "他人的回答" });
  return { deps, store, app, m1, m2, login, c1, msgId, c2, msg2Id };
}

beforeEach(() => { process.env.AGENTANY_DEV_TOKEN = "dev-test-token"; }); // auth 强制态（=prod）
afterEach(() => { delete process.env.AGENTANY_DEV_TOKEN; }); // 防泄漏同进程其它测试文件（auth.test 同款纪律）

describe("POST /feedback/message（消息级 👍/👎）", () => {
  test("仅 rating（👍→5）→ 201（放宽：text/rating 至少其一）", async () => {
    const ctx = await setup();
    const tok = await ctx.login("m1");
    const r = await ctx.app.request(`/feedback/message/${ctx.msgId}`, {
      method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ rating: 5 }),
    });
    expect(r.status).toBe(201);
    const rows = ctx.store.getFeedback("message", String(ctx.msgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(5);
    expect(rows[0].text).toBe(""); // 无备注空串（text 列 NOT NULL）
  });

  test("仅 text（补备注）→ 201；text+rating 同给 → 201", async () => {
    const ctx = await setup();
    const tok = await ctx.login("m1");
    expect((await ctx.app.request(`/feedback/message/${ctx.msgId}`, {
      method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ text: "很好，正是我要的" }),
    })).status).toBe(201);
    expect((await ctx.app.request(`/feedback/message/${ctx.msgId}`, {
      method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ text: "补充", rating: 2 }),
    })).status).toBe(201);
  });

  test("text 与 rating 全缺 → 400；rating 越界（0/6）→ 400", async () => {
    const ctx = await setup();
    const tok = await ctx.login("m1");
    expect((await ctx.app.request(`/feedback/message/${ctx.msgId}`, {
      method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({}),
    })).status).toBe(400);
    for (const bad of [0, 6]) {
      expect((await ctx.app.request(`/feedback/message/${ctx.msgId}`, {
        method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ rating: bad }),
      })).status).toBe(400);
    }
  });

  test("他人会话的消息 → 404；不存在 → 404（不泄漏）；未登录 → 401", async () => {
    const ctx = await setup();
    const tok2 = await ctx.login("m2");
    expect((await ctx.app.request(`/feedback/message/${ctx.msgId}`, {
      method: "POST", headers: { ...JH, authorization: tok2 }, body: JSON.stringify({ rating: 5 }),
    })).status).toBe(404);
    const tok = await ctx.login("m1");
    expect((await ctx.app.request("/feedback/message/99999", {
      method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ rating: 5 }),
    })).status).toBe(404);
    expect((await ctx.app.request(`/feedback/message/${ctx.msgId}`, {
      method: "POST", headers: JH, body: JSON.stringify({ rating: 5 }),
    })).status).toBe(401);
  });

  test("作者落库 + 回显按人（Spec-4：admin 不误吞他人反馈）", async () => {
    const ctx = await setup();
    const tokM1 = await ctx.login("m1");
    await ctx.app.request(`/feedback/message/${ctx.msgId}`, {
      method: "POST", headers: { ...JH, authorization: tokM1 }, body: JSON.stringify({ rating: 5 }),
    });
    // admin 也点同消息 👎
    const tokAd = await ctx.login("ad");
    await ctx.app.request(`/feedback/message/${ctx.msgId}`, {
      method: "POST", headers: { ...JH, authorization: tokAd }, body: JSON.stringify({ rating: 1 }),
    });
    const r = await ctx.app.request(`/feedback/message/${ctx.msgId}`, { headers: { authorization: tokAd } });
    const rows = await r.json() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.authorId)).toEqual([ctx.m1.id, (await ctx).deps.userStore!.getUserByUsername("ad")!.id]);
  });

  test("未知 targetKind → 400（白名单外挂载点不开）", async () => {
    const ctx = await setup();
    const tok = await ctx.login("m1");
    expect((await ctx.app.request("/feedback/whatever/1", {
      method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ text: "x" }),
    })).status).toBe(400);
  });
});

describe("GET /feedback（回显数据源）", () => {
  test("本人 → 200 列表；他人 → 404；admin → 200", async () => {
    const ctx = await setup();
    ctx.store.addFeedback({ targetKind: "message", targetId: String(ctx.msgId), text: "备注", rating: 5 });
    const tok = await ctx.login("m1");
    const r = await ctx.app.request(`/feedback/message/${ctx.msgId}`, { headers: { authorization: tok } });
    expect(r.status).toBe(200);
    const rows = await r.json() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("备注");
    expect((await ctx.app.request(`/feedback/message/${ctx.msgId}`, { headers: { authorization: await ctx.login("m2") } })).status).toBe(404);
    expect((await ctx.app.request(`/feedback/message/${ctx.msgId}`, { headers: { authorization: await ctx.login("ad") } })).status).toBe(200);
  });
});

describe("POST /feedback/workflow_run（run 级批注+评分）", () => {
  test("本人会话的 run → 201 落库；他人 → 404；run 不存在 → 404", async () => {
    const ctx = await setup();
    const runId = "r_" + globalThis.crypto.randomUUID();
    ctx.store.createRun({ runId, workflowId: "brand-research", workspaceId: "ws_company", conversationId: ctx.c1.id, input: {} });
    const tok = await ctx.login("m1");
    const r = await ctx.app.request(`/feedback/workflow_run/${runId}`, {
      method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ text: "这次调研很全", rating: 4 }),
    });
    expect(r.status).toBe(201);
    const rows = ctx.store.getFeedback("workflow_run", runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(4);
    expect((await ctx.app.request(`/feedback/workflow_run/${runId}`, {
      method: "POST", headers: { ...JH, authorization: await ctx.login("m2") }, body: JSON.stringify({ rating: 5 }),
    })).status).toBe(404);
    expect((await ctx.app.request("/feedback/workflow_run/r_nope", {
      method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ text: "x" }),
    })).status).toBe(404);
  });

  test("chat 会话级反馈（ADR-0008 老语义）：本人 → 201；他人会话 → 404", async () => {
    const ctx = await setup();
    const tok = await ctx.login("m1");
    expect((await ctx.app.request(`/feedback/chat/${ctx.c1.id}`, {
      method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ text: "对话反馈" }),
    })).status).toBe(201);
    expect((await ctx.app.request(`/feedback/chat/${ctx.c1.id}`, {
      method: "POST", headers: { ...JH, authorization: await ctx.login("m2") }, body: JSON.stringify({ text: "x" }),
    })).status).toBe(404);
  });
});
