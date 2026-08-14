// 项目 + 成员管理（ADR-0013/0014，步骤 b）。用 makeDeps（共享 db：projectStore join users 须同库）。
// env：AGENTANY_DEV_TOKEN 设为「auth 强制」态（吊销/无 token → 401）；afterEach 清理防泄漏到其它测试文件。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { makeDeps } from "./deps";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };
const H = (token?: string) => (token ? { authorization: `Bearer ${token}`, ...JH } : { ...JH });

describe("projects + members", () => {
  let deps: RunDeps;
  let app: ReturnType<typeof createApp>;
  let ownerTok: string, memberTok: string, outsiderTok: string;
  let ownerId: string, memberId: string, outsiderId: string;

  beforeEach(async () => {
    deps = makeDeps();
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token"; // auth 强制态
    const owner = await deps.userStore.createUser({ username: "owner", password: "password1" });
    const member = await deps.userStore.createUser({ username: "member", password: "password1" });
    const outsider = await deps.userStore.createUser({ username: "outsider", password: "password1" });
    ownerId = owner.id;
    memberId = member.id;
    outsiderId = outsider.id;
    app = createApp(deps);
    const tok = async (u: string): Promise<string> =>
      ((await (await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: u, password: "password1" }) })).json()) as any).token;
    ownerTok = await tok("owner");
    memberTok = await tok("member");
    outsiderTok = await tok("outsider");
  });
  afterEach(() => {
    delete process.env.AGENTANY_DEV_TOKEN;
  });

  const createProject = async (token: string, slug: string, name = "Acme") =>
    (await (await app.request("/projects", { method: "POST", headers: H(token), body: JSON.stringify({ slug, name }) })).json()) as any;

  test("无 token → 401（auth 强制态）", async () => {
    expect((await app.request("/projects", { method: "POST", headers: H(), body: JSON.stringify({ slug: "x", name: "X" }) })).status).toBe(401);
    expect((await app.request("/projects", { headers: H() })).status).toBe(401);
  });

  test("建项目 → 201、id=p_<uuid>、创建者=owner 成员", async () => {
    const r = await app.request("/projects", { method: "POST", headers: H(ownerTok), body: JSON.stringify({ slug: "acme", name: "Acme" }) });
    expect(r.status).toBe(201);
    const p: any = await r.json();
    expect(p.id).toMatch(/^p_[0-9a-f-]{36}$/);
    expect(p.slug).toBe("acme");
    expect(p.ownerId).toBe(ownerId);
    expect(p).not.toHaveProperty("passwordHash");
    const members = (await (await app.request(`/projects/${p.id}/members`, { headers: H(ownerTok) })).json()) as any[];
    expect(members.length).toBe(1);
    expect(members[0].userId).toBe(ownerId);
    expect(members[0].role).toBe("owner");
    expect(members[0].username).toBe("owner");
    // getProjectBySlug（spec 补齐）
    expect(deps.projectStore.getProjectBySlug("acme")?.id).toBe(p.id);
    expect(deps.projectStore.getProjectBySlug("nope")).toBeNull();
  });

  test("slug 重名→409；非法（大写/空格/前导-/空）→400", async () => {
    expect((await app.request("/projects", { method: "POST", headers: H(ownerTok), body: JSON.stringify({ slug: "acme", name: "A" }) })).status).toBe(201);
    expect((await app.request("/projects", { method: "POST", headers: H(memberTok), body: JSON.stringify({ slug: "acme", name: "X" }) })).status).toBe(409);
    for (const bad of ["Acme", "acme space", "-acme", ""]) {
      expect((await app.request("/projects", { method: "POST", headers: H(memberTok), body: JSON.stringify({ slug: bad, name: "X" }) })).status).toBe(400);
    }
  });

  test("GET /projects 只列「我是成员」的项目", async () => {
    await createProject(ownerTok, "a", "A");
    await createProject(memberTok, "b", "B");
    const ownerList = (await (await app.request("/projects", { headers: H(ownerTok) })).json()) as any[];
    expect(ownerList.map((p) => p.slug)).toEqual(["a"]);
    const memberList = (await (await app.request("/projects", { headers: H(memberTok) })).json()) as any[];
    expect(memberList.map((p) => p.slug)).toEqual(["b"]);
    const outsiderList = (await (await app.request("/projects", { headers: H(outsiderTok) })).json()) as any[];
    expect(outsiderList.length).toBe(0);
  });

  test("非成员 GET /projects/:id → 404（不泄漏存在）；成员 → 200", async () => {
    const p = await createProject(ownerTok, "a");
    expect((await app.request(`/projects/${p.id}`, { headers: H(ownerTok) })).status).toBe(200);
    expect((await app.request(`/projects/${p.id}`, { headers: H(outsiderTok) })).status).toBe(404);
    expect((await app.request(`/projects/p_nope`, { headers: H(outsiderTok) })).status).toBe(404);
  });

  test("owner PATCH→200；member PATCH→403", async () => {
    const p = await createProject(ownerTok, "a");
    expect((await app.request(`/projects/${p.id}/members`, { method: "POST", headers: H(ownerTok), body: JSON.stringify({ userId: memberId }) })).status).toBe(201);
    const patched = await app.request(`/projects/${p.id}`, { method: "PATCH", headers: H(ownerTok), body: JSON.stringify({ name: "A2", description: "d" }) });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).name).toBe("A2");
    expect((await app.request(`/projects/${p.id}`, { method: "PATCH", headers: H(memberTok), body: JSON.stringify({ name: "X" }) })).status).toBe(403);
  });

  test("加成员：存在→201、重复→409、userId 不存在→404、非 owner→403", async () => {
    const p = await createProject(ownerTok, "a");
    expect((await app.request(`/projects/${p.id}/members`, { method: "POST", headers: H(ownerTok), body: JSON.stringify({ userId: memberId }) })).status).toBe(201);
    expect((await app.request(`/projects/${p.id}/members`, { method: "POST", headers: H(ownerTok), body: JSON.stringify({ userId: memberId }) })).status).toBe(409);
    expect((await app.request(`/projects/${p.id}/members`, { method: "POST", headers: H(ownerTok), body: JSON.stringify({ userId: "u_nope" }) })).status).toBe(404);
    expect((await app.request(`/projects/${p.id}/members`, { method: "POST", headers: H(ownerTok), body: JSON.stringify({ userId: outsiderId, role: "boss" }) })).status).toBe(400);
    // member 已入项目但非 owner → 加 outsider 被拒
    expect((await app.request(`/projects/${p.id}/members`, { method: "POST", headers: H(memberTok), body: JSON.stringify({ userId: outsiderId }) })).status).toBe(403);
    // listMembers 出 username
    const members = (await (await app.request(`/projects/${p.id}/members`, { headers: H(memberTok) })).json()) as any[];
    expect(members.map((m) => m.username).sort()).toEqual(["member", "owner"]);
  });

  test("移除成员：member 自删→200、owner 移 member→200、最后 owner 自移→409", async () => {
    const p = await createProject(ownerTok, "a");
    await app.request(`/projects/${p.id}/members`, { method: "POST", headers: H(ownerTok), body: JSON.stringify({ userId: memberId }) });
    // member 自删
    expect((await app.request(`/projects/${p.id}/members/${memberId}`, { method: "DELETE", headers: H(memberTok) })).status).toBe(200);
    // 非 member 的 outsider 动别人 → 404（非成员不泄漏）
    expect((await app.request(`/projects/${p.id}/members/${ownerId}`, { method: "DELETE", headers: H(outsiderTok) })).status).toBe(404);
    // 只剩 owner 一个 → 自移被拒（防项目无主）
    expect((await app.request(`/projects/${p.id}/members/${ownerId}`, { method: "DELETE", headers: H(ownerTok) })).status).toBe(409);
    // 加第二个 owner 后 → 原 owner 可自移（ownership 经此移交）
    expect((await app.request(`/projects/${p.id}/members`, { method: "POST", headers: H(ownerTok), body: JSON.stringify({ userId: outsiderId, role: "owner" }) })).status).toBe(201);
    expect((await app.request(`/projects/${p.id}/members/${ownerId}`, { method: "DELETE", headers: H(ownerTok) })).status).toBe(200);
    // 移交后 outsider（新 owner）仍在成员列表
    const members = (await (await app.request(`/projects/${p.id}/members`, { headers: H(outsiderTok) })).json()) as any[];
    expect(members.map((m) => m.userId).sort()).toEqual([outsiderId].sort());
  });
});
