// WORKSPACE 实体化 + 鉴权边界（ADR-0018，步骤 c）。用 makeDeps（共享 db：名单 join users 须同库）。
// env：AGENTANY_DEV_TOKEN 设为「auth 强制」态（无 token → 401）；afterEach 清理防泄漏到其它测试文件。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { makeDeps } from "./deps";
import { childEnv } from "../src/pi/runPi";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };
const H = (token?: string) => (token ? { authorization: `Bearer ${token}`, ...JH } : { ...JH });

describe("workspace + 鉴权边界（ADR-0018）", () => {
  let deps: RunDeps;
  let app: ReturnType<typeof createApp>;
  let adminTok: string, m1Tok: string, outTok: string;
  let m1Id: string, outId: string;

  beforeEach(async () => {
    // runPi stub：起 run 用例不 spawn 真 pi（同 security.hotfix 体例）
    deps = makeDeps({
      runPiFactory: () => async () => ({ text: "[stub]", messages: [], toolResults: [] }),
    });
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token"; // auth 强制态
    // 真 admin（bootstrap 语义：直接建 role=admin 用户）
    const admin = await deps.userStore.createUser({ username: "admin", password: "password1", role: "admin" });
    const m1 = await deps.userStore.createUser({ username: "m1", password: "password1" });
    const out = await deps.userStore.createUser({ username: "out", password: "password1" });
    m1Id = m1.id;
    outId = out.id;
    app = createApp(deps);
    const tok = async (u: string): Promise<string> =>
      ((await (await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: u, password: "password1" }) })).json()) as any).token;
    adminTok = await tok("admin");
    m1Tok = await tok("m1");
    outTok = await tok("out");
  });
  afterEach(() => {
    delete process.env.AGENTANY_DEV_TOKEN;
  });

  const createWs = async (body: Record<string, unknown>, token = adminTok) =>
    app.request("/workspaces", { method: "POST", headers: H(token), body: JSON.stringify(body) });

  const createConv = async (token: string, body: Record<string, unknown> = {}) =>
    (await (await app.request("/conversations", { method: "POST", headers: H(token), body: JSON.stringify(body) })).json()) as any;

  test("迁移 seed：公司 ws 存在且 allUsers", () => {
    const ws = deps.workspaceStore.getWorkspace("ws_company");
    expect(ws?.slug).toBe("company");
    expect(ws?.allUsers).toBe(true);
  });

  test("建 ws：普通用户 403；admin 201；slug 重 409；userId 不存在 404；重复 memberIds 去重不误报", async () => {
    expect((await createWs({ slug: "x", name: "X" }, m1Tok)).status).toBe(403);
    const r = await createWs({ slug: "acme", name: "Acme", allUsers: false, memberIds: [m1Id] });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).id).toMatch(/^ws_[0-9a-f-]{36}$/);
    expect((await createWs({ slug: "acme", name: "A2" })).status).toBe(409);
    expect((await createWs({ slug: "ok", name: "O", memberIds: ["u_nope"] })).status).toBe(404);
    // 重复 memberIds：去重后正常建（曾误报 slug taken 409）
    const dup = await createWs({ slug: "dup", name: "D", memberIds: [m1Id, m1Id] });
    expect(dup.status).toBe(201);
    for (const bad of ["Acme", "acme space", "-acme", ""]) {
      expect((await createWs({ slug: bad, name: "X" })).status).toBe(400);
    }
  });

  test("名单编辑：admin 加/删 200；普通 403；重复加 409", async () => {
    const ws: any = await (await createWs({ slug: "acme", name: "Acme" })).json();
    expect((await app.request(`/workspaces/${ws.id}/members`, { method: "POST", headers: H(m1Tok), body: JSON.stringify({ userId: m1Id }) })).status).toBe(403);
    expect((await app.request(`/workspaces/${ws.id}/members`, { method: "POST", headers: H(adminTok), body: JSON.stringify({ userId: m1Id }) })).status).toBe(201);
    expect((await app.request(`/workspaces/${ws.id}/members`, { method: "POST", headers: H(adminTok), body: JSON.stringify({ userId: m1Id }) })).status).toBe(409);
    expect((await app.request(`/workspaces/${ws.id}`, { method: "PATCH", headers: H(adminTok), body: JSON.stringify({ name: "A2" }) })).status).toBe(200);
    expect((await app.request(`/workspaces/${ws.id}`, { method: "PATCH", headers: H(m1Tok), body: JSON.stringify({ name: "X" }) })).status).toBe(403);
    expect((await app.request(`/workspaces/${ws.id}/members/${m1Id}`, { method: "DELETE", headers: H(adminTok) })).status).toBe(200);
  });

  test("GET /workspaces：member 见 company+名单 ws；outsider 只见 company；admin 全部；详情含名单", async () => {
    const ws: any = await (await createWs({ slug: "acme", name: "Acme", memberIds: [m1Id] })).json();
    await createWs({ slug: "secret", name: "S" }); // 名单空
    const mine = (await (await app.request("/workspaces", { headers: H(m1Tok) })).json()) as any[];
    expect(mine.map((w) => w.slug).sort()).toEqual(["acme", "company"]);
    const outList = (await (await app.request("/workspaces", { headers: H(outTok) })).json()) as any[];
    expect(outList.map((w) => w.slug)).toEqual(["company"]);
    const all = (await (await app.request("/workspaces", { headers: H(adminTok) })).json()) as any[];
    expect(all.length).toBe(3);
    // 详情：成员可见、含名单；外人 404
    const detail = (await (await app.request(`/workspaces/${ws.id}`, { headers: H(m1Tok) })).json()) as any;
    expect(detail.members.map((m: any) => m.username)).toEqual(["m1"]);
    expect((await app.request(`/workspaces/${ws.id}`, { headers: H(outTok) })).status).toBe(404);
    // 不存在的 id：admin 也 404（曾因非空断言 500——存在性独立于 admin 全通）
    expect((await app.request("/workspaces/ws_nope", { headers: H(adminTok) })).status).toBe(404);
  });

  test("POST /conversations：无参→ws_company；名单 ws 成员 201；名单外/不存在 404；projectId 字段废止", async () => {
    const ws: any = await (await createWs({ slug: "acme", name: "Acme", memberIds: [m1Id] })).json();
    expect((await createConv(m1Tok)).workspaceId).toBe("ws_company");
    expect((await createConv(m1Tok, { workspaceId: ws.id })).workspaceId).toBe(ws.id);
    expect((await app.request("/conversations", { method: "POST", headers: H(outTok), body: JSON.stringify({ workspaceId: ws.id }) })).status).toBe(404);
    expect((await app.request("/conversations", { method: "POST", headers: H(m1Tok), body: JSON.stringify({ workspaceId: "ws_nope" }) })).status).toBe(404);
    expect((await app.request("/conversations", { method: "POST", headers: H(m1Tok), body: JSON.stringify({ workspaceId: "../etc" }) })).status).toBe(400);
    expect((await app.request("/conversations", { method: "POST", headers: H(m1Tok), body: JSON.stringify({ projectId: "dev" }) })).status).toBe(404);
  });

  test("会话私有：他人（含同 ws 同事）404；创建者 200/202；admin 200", async () => {
    const ws: any = await (await createWs({ slug: "acme", name: "Acme", memberIds: [m1Id, outId] })).json();
    const conv = await createConv(m1Tok, { workspaceId: ws.id });
    for (const [path, init] of [
      [`/conversations/${conv.id}`, {}],
      [`/conversations/${conv.id}/messages`, {}],
      [`/conversations/${conv.id}/messages`, { method: "POST", body: JSON.stringify({ content: "hi" }) }],
      [`/conversations/${conv.id}/abort`, { method: "POST" }],
      [`/conversations/${conv.id}/hitl`, {}],
    ] as const) {
      expect((await app.request(path, { method: init.method ?? "GET", headers: H(outTok), ...(init as any) })).status).toBe(404);
    }
    // SSE：非创建者建连即 404（不进流）
    expect((await app.request(`/conversations/${conv.id}/stream`, { headers: H(outTok) })).status).toBe(404);
    // 创建者正常
    expect((await app.request(`/conversations/${conv.id}`, { headers: H(m1Tok) })).status).toBe(200);
    expect((await app.request(`/conversations/${conv.id}/messages`, { method: "POST", headers: H(m1Tok), body: JSON.stringify({ content: "hi" }) })).status).toBe(202);
    // admin 全通
    expect((await app.request(`/conversations/${conv.id}`, { headers: H(adminTok) })).status).toBe(200);
  });

  test("起 run：无参→公司 ws 成功；名单外 wsId 404；run 可见性随 ws", async () => {
    const ws: any = await (await createWs({ slug: "acme", name: "Acme", memberIds: [m1Id] })).json();
    // 无参（公司 ws）+ stub pi → 成功
    const r1 = await app.request("/workflows/synthetic-3step/runs", { method: "POST", headers: H(m1Tok), body: JSON.stringify({ input: {} }) });
    expect([200, 201, 202]).toContain(r1.status);
    const companyRun = (await r1.json()) as any;
    // 公司 run：任何登录用户可读（allUsers）
    expect((await app.request(`/runs/${companyRun.runId}`, { headers: H(outTok) })).status).toBe(200);
    // 名单外 ws → 404
    expect((await app.request("/workflows/synthetic-3step/runs", { method: "POST", headers: H(outTok), body: JSON.stringify({ workspaceId: ws.id, input: {} }) })).status).toBe(404);
    // 成员起 ws run → 成功；外人读 → 404
    const r2 = await app.request("/workflows/synthetic-3step/runs", { method: "POST", headers: H(m1Tok), body: JSON.stringify({ workspaceId: ws.id, input: {} }) });
    expect([200, 201, 202]).toContain(r2.status);
    const wsRun = (await r2.json()) as any;
    expect((await app.request(`/runs/${wsRun.runId}`, { headers: H(outTok) })).status).toBe(404);
    expect((await app.request(`/runs/${wsRun.runId}`, { headers: H(m1Tok) })).status).toBe(200);
  });

  test("审批卡应答（消息绑定）：非会话可见者发不进消息（404）→ 卡不动；创建者答 → 卡 answered", async () => {
    // #28 重构：/approvals 路由已删——审批走 POST /messages inReplyTo（会话守卫天然挡外部人）。
    const conv = await createConv(m1Tok);
    const qId = deps.hitlStore.createQuestion({
      conversationId: conv.id, runId: null, kind: "approval", workflowId: "synthetic-3step",
      input: {}, prompt: "批？", options: ["批准", "拒绝"],
    });
    expect((await app.request(`/conversations/${conv.id}/messages`, { method: "POST", headers: H(outTok), body: JSON.stringify({ content: "拒绝", inReplyTo: qId }) })).status).toBe(404);
    expect((await app.request(`/conversations/${conv.id}/messages`, { method: "POST", headers: H(m1Tok), body: JSON.stringify({ content: "拒绝", inReplyTo: qId }) })).status).toBe(202);
    expect(deps.hitlStore.getQuestion(qId)!.status).toBe("answered");
    expect((deps.hitlStore.getQuestion(qId)!.answer as any).decision).toBe("deny");
  });

  test("名单读时过滤 active：注销用户不出现于名单", async () => {
    const ws: any = await (await createWs({ slug: "acme", name: "Acme", memberIds: [m1Id, outId] })).json();
    await deps.userStore.deactivateUser(outId);
    const detail = (await (await app.request(`/workspaces/${ws.id}`, { headers: H(m1Tok) })).json()) as any;
    expect(detail.members.map((m: any) => m.username)).toEqual(["m1"]);
  });

  test("childEnv：不透传 AGENTANY_DEV_USER（泄漏收口）", () => {
    process.env.AGENTANY_DEV_USER = "leak-check";
    const env = childEnv({});
    expect("AGENTANY_DEV_USER" in env).toBe(false);
    delete process.env.AGENTANY_DEV_USER;
  });
});
