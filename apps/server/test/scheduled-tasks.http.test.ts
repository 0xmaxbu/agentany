// 定时任务 API 测试（#25 / ADR-0021 切片 1）：建任务 tracer——三表 + 建任务 API + 产出会话派生 + 频率下限。
// HTTP seam（先例 feedback.http.test.ts）：createApp + app.request，makeDeps :memory: db。
// 身份：dev 逃生阀未设 → admin；显式 login 建 member（user-admin 先例）。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { makeDeps } from "./deps";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };

/** 建 admin（dev 放行默认即 admin，但显式 login 拿同一身份更真实）+ member 两个账号，返各自 headers。 */
async function mkUsers(app: ReturnType<typeof createApp>) {
  // dev 逃生阀（未设 AGENTANY_DEV_TOKEN）放行为 admin——直接用，无需 login。
  const admin = JH; // 无需 token（中间件 dev 放行）
  const mk = await app.request("/users", {
    method: "POST", headers: admin,
    body: JSON.stringify({ username: "m1", password: "pw-m1-Long", displayName: "Member One" }),
  });
  if (mk.status !== 201) throw new Error("mk member failed: " + JSON.stringify(await mk.json()));
  const login = await app.request("/auth/login", {
    method: "POST", headers: JH, body: JSON.stringify({ username: "m1", password: "pw-m1-Long" }),
  });
  const { token } = (await login.json()) as { token: string };
  return { admin, member: { ...JH, authorization: `Bearer ${token}` }, memberId: undefined as unknown as string };
}

/** member userId：建一个会话读回 owner。 */
async function memberIdOf(app: ReturnType<typeof createApp>, member: Record<string, string>): Promise<string> {
  const post = await app.request("/conversations", { method: "POST", headers: member, body: JSON.stringify({}) });
  const conv = (await post.json()) as { userId: string };
  return conv.userId;
}

const taskBody = (over: Record<string, unknown> = {}) => ({
  displayName: "新闻汇总",
  cron: "0 */4 * * *", // 每 4 小时——合法频率
  prompt: "去 xx 网站读最新新闻，提取摘要",
  ...over,
});

describe("POST /scheduled-tasks（建任务 tracer）", () => {
  test("member 建 workspace 任务 → 201，事务内派生产出会话（挂同 ws、标题=displayName）", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member } = await mkUsers(app);
    const post = await app.request("/scheduled-tasks", { method: "POST", headers: member, body: JSON.stringify(taskBody()) });
    expect(post.status).toBe(201);
    const task = (await post.json()) as any;
    expect(task.id).toStartWith("t_");
    expect(task.scope).toBe("workspace");
    expect(task.displayName).toBe("新闻汇总");
    expect(task.cron).toBe("0 */4 * * *");
    expect(task.enabled).toBe(true);
    // 产出会话：挂任务同 ws（缺省公司 ws）、标题=displayName、创建者=建任务的人
    const conv = deps.store.getConversation(task.outputConversationId);
    expect(conv).toBeDefined();
    expect(conv!.title).toBe("新闻汇总");
    expect(conv!.workspaceId).toBe("ws_company");
    expect(conv!.userId).toBe(await memberIdOf(app, member)); // 同一 member
    // nextFireAt：已算出（未来时间、ISO）
    expect(typeof task.nextFireAt).toBe("string");
    expect(new Date(task.nextFireAt!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test("指定 workspaceId：产出会话挂该 ws", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member } = await mkUsers(app);
    const post = await app.request("/scheduled-tasks", {
      method: "POST", headers: member,
      body: JSON.stringify(taskBody({ workspaceId: "ws_company" })),
    });
    expect(post.status).toBe(201);
    const task = (await post.json()) as any;
    expect(deps.store.getConversation(task.outputConversationId)!.workspaceId).toBe("ws_company");
  });

  test("scope=system 经 API 直建 → 400/403 拒（仅 seed/代码可建）", async () => {
    const app = createApp(makeDeps());
    const { admin } = await mkUsers(app);
    const res = await app.request("/scheduled-tasks", {
      method: "POST", headers: admin,
      body: JSON.stringify(taskBody({ scope: "system" })),
    });
    expect([400, 403]).toContain(res.status);
  });

  test("频率下限：相邻火点 <1h（*/30 分钟）→ 422", async () => {
    const app = createApp(makeDeps());
    const { member } = await mkUsers(app);
    const res = await app.request("/scheduled-tasks", { method: "POST", headers: member, body: JSON.stringify(taskBody({ cron: "*/30 * * * *" })) });
    expect(res.status).toBe(422);
    const err = (await res.json()) as any;
    expect(err.error).toMatch(/1h|频率|frequency/i);
  });

  test("恰好 1h（0 * * * *）= 下限本身 → 放行（ADR-0021：下限即最小合法间隔）", async () => {
    const app = createApp(makeDeps());
    const { member } = await mkUsers(app);
    const res = await app.request("/scheduled-tasks", { method: "POST", headers: member, body: JSON.stringify(taskBody({ cron: "0 * * * *" })) });
    expect(res.status).toBe(201);
  });

  test("cron 非法 → 400", async () => {
    const app = createApp(makeDeps());
    const { member } = await mkUsers(app);
    const res = await app.request("/scheduled-tasks", { method: "POST", headers: member, body: JSON.stringify(taskBody({ cron: "not-a-cron" })) });
    expect(res.status).toBe(400);
  });

  test("缺 displayName/prompt → 400", async () => {
    const app = createApp(makeDeps());
    const { member } = await mkUsers(app);
    const noName = await app.request("/scheduled-tasks", { method: "POST", headers: member, body: JSON.stringify(taskBody({ displayName: undefined })) });
    expect(noName.status).toBe(400);
    const noPrompt = await app.request("/scheduled-tasks", { method: "POST", headers: member, body: JSON.stringify(taskBody({ prompt: undefined })) });
    expect(noPrompt.status).toBe(400);
  });
});

describe("GET /scheduled-tasks（权限分野）", () => {
  test("member 只见自己建的；admin 全量含 system seed", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member, admin } = await mkUsers(app);
    await app.request("/scheduled-tasks", { method: "POST", headers: member, body: JSON.stringify(taskBody({ displayName: "我的任务" })) });

    const mList = (await (await app.request("/scheduled-tasks", { headers: member })).json()) as any[];
    // seed（system 蒸馏）对 member 不可见
    expect(mList.every((t) => t.scope !== "system")).toBe(true);
    expect(mList.some((t) => t.displayName === "我的任务")).toBe(true);

    const aList = (await (await app.request("/scheduled-tasks", { headers: admin })).json()) as any[];
    expect(aList.some((t) => t.scope === "system")).toBe(true); // admin 见 seed
    expect(aList.some((t) => t.displayName === "我的任务")).toBe(true);
    const seed = aList.find((t) => t.scope === "system");
    expect(seed.outputConversationId).toBeNull(); // system 无产出会话
  });

  test("两个 member 互相不可见", async () => {
    const app = createApp(makeDeps());
    const { member } = await mkUsers(app);
    await app.request("/users", { method: "POST", headers: JH, body: JSON.stringify({ username: "m2", password: "pw-m2-Long" }) });
    const l2 = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "m2", password: "pw-m2-Long" }) });
    const m2 = { ...JH, authorization: `Bearer ${(await l2.json() as any).token}` };
    await app.request("/scheduled-tasks", { method: "POST", headers: member, body: JSON.stringify(taskBody()) });
    const list2 = (await (await app.request("/scheduled-tasks", { headers: m2 })).json()) as any[];
    expect(list2.filter((t) => t.scope === "workspace")).toHaveLength(0);
  });
});

describe("seed（迁移幂等）", () => {
  test("蒸馏 system 行存在且 nextFireAt 已算", () => {
    const deps = makeDeps();
    const list = deps.taskStore!.listTasks({ includeSystem: true });
    const seed = list.find((t: any) => t.scope === "system");
    expect(seed).toBeDefined();
    expect(seed!.displayName).toMatch(/经验|蒸馏|distill/i);
    expect(typeof seed!.nextFireAt).toBe("string");
  });
});
