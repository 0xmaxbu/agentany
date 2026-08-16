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

/** 第二个 member（权限矩阵对照组）：建号+login 一步到位。 */
async function mkM2(app: ReturnType<typeof createApp>): Promise<Record<string, string>> {
  await app.request("/users", { method: "POST", headers: JH, body: JSON.stringify({ username: "m2", password: "pw-m2-Long" }) });
  const l = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "m2", password: "pw-m2-Long" }) });
  return { ...JH, authorization: `Bearer ${(await l.json() as any).token}` };
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

  test("scope=system 经 API 直建：member 403（#39/ADR-0023 决策 4——admin 放开，member 仍拒）", async () => {
    const app = createApp(makeDeps());
    const { member } = await mkUsers(app);
    const res = await app.request("/scheduled-tasks", {
      method: "POST", headers: member,
      body: JSON.stringify(taskBody({ scope: "system" })),
    });
    expect(res.status).toBe(403); // 旧语义（400/403 拒 admin 也拒）已随 ADR-0021 决策 7 修订作废
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
    const m2 = await mkM2(app);
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

describe("POST /scheduled-tasks/:id/run（手动调用，#26）", () => {
  const mkTaskAs = async (app: ReturnType<typeof createApp>, headers: Record<string, string>, name = "手动任务") => {
    const post = await app.request("/scheduled-tasks", { method: "POST", headers, body: JSON.stringify(taskBody({ displayName: name })) });
    return (await post.json()) as any;
  };

  test("立即执行：trigger=manual、nextFireAt 不动；落 runs", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member } = await mkUsers(app);
    const task = await mkTaskAs(app, member);
    const before = task.nextFireAt;
    // 手动跑经 scheduler.runManual——HTTP 层注入 spy scheduler
    const calls: any[] = [];
    deps.scheduler = {
      runManual: (t: any) => { calls.push(t); return 1; },
      isRunning: () => false,
    } as any;
    const res = await app.request(`/scheduled-tasks/${task.id}/run`, { method: "POST", headers: member });
    expect(res.status).toBe(202);
    expect(calls.map((t) => t.id)).toEqual([task.id]);
    const after = deps.taskStore!.getTask(task.id)!;
    expect(after.nextFireAt).toBe(before); // 手动不推进
    const runs = deps.taskStore!.listRuns(task.id);
    expect(runs).toHaveLength(0); // runManual spy 未写真 runs——真实 scheduler 在 index 装配
  });

  test("同任务在跑 → 409", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member } = await mkUsers(app);
    const task = await mkTaskAs(app, member);
    deps.scheduler = { runManual: () => undefined, isRunning: () => false } as any;
    const res = await app.request(`/scheduled-tasks/${task.id}/run`, { method: "POST", headers: member });
    expect(res.status).toBe(409);
  });

  test("member 跑别人的任务 → 404；admin 跑任意 → 202", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member, admin } = await mkUsers(app);
    const m2 = await mkM2(app);
    const task = await mkTaskAs(app, m2, "m2 的任务");
    deps.scheduler = { runManual: () => 1, isRunning: () => false } as any;
    const forbidden = await app.request(`/scheduled-tasks/${task.id}/run`, { method: "POST", headers: member });
    expect(forbidden.status).toBe(404); // 不泄漏存在
    const ok = await app.request(`/scheduled-tasks/${task.id}/run`, { method: "POST", headers: admin });
    expect(ok.status).toBe(202);
  });

  test("任务不存在 → 404", async () => {
    const app = createApp(makeDeps());
    const { member } = await mkUsers(app);
    const res = await app.request("/scheduled-tasks/t_none/run", { method: "POST", headers: member });
    expect(res.status).toBe(404);
  });
});

describe("管理闭环（#27）：runs 历史 + 未读数点开即清 + 启停删与 system 保护", () => {
  const mkTaskAs = async (app: any, headers: Record<string, string>, name = "T") => {
    const post = await app.request("/scheduled-tasks", { method: "POST", headers, body: JSON.stringify(taskBody({ displayName: name })) });
    return (await post.json()) as any;
  };

  /** 造 runs：直写 store（runs 由 scheduler 产生——HTTP 层不关心来源）。 */
  const seedRuns = (deps: any, taskId: string, n: number) => {
    for (let i = 0; i < n; i++) deps.taskStore!.recordRun({ taskId, trigger: "cron", status: "ok", startedAt: new Date().toISOString() });
  };

  test("GET /:id/runs：member 读自己的；admin 读任意（含 system seed）；member 读他人 → 404", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member, admin } = await mkUsers(app);
    const m2 = await mkM2(app);
    const mine = await mkTaskAs(app, member, "我的");
    const theirs = await mkTaskAs(app, m2, "m2 的");
    seedRuns(deps, mine.id, 2);

    const okMine = await app.request(`/scheduled-tasks/${mine.id}/runs`, { headers: member });
    expect(okMine.status).toBe(200);
    const runs = (await okMine.json()) as any[];
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveProperty("status");
    expect(runs[0]).toHaveProperty("trigger");
    expect(runs[0]).toHaveProperty("startedAt");
    expect(runs[0]).toHaveProperty("finishedAt");
    expect(runs[0]).toHaveProperty("outputMessageId");

    const notMine = await app.request(`/scheduled-tasks/${theirs.id}/runs`, { headers: member });
    expect(notMine.status).toBe(404); // 不泄漏存在

    const seed = deps.taskStore!.listTasks({ includeSystem: true }).find((t: any) => t.scope === "system")!;
    const adminSees = await app.request(`/scheduled-tasks/${seed.id}/runs`, { headers: admin });
    expect(adminSees.status).toBe(200);
  });

  test("admin 列表附 unreadCounts；POST /:id/view 点开即清", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member, admin } = await mkUsers(app);
    const task = await mkTaskAs(app, member, "带未读");
    seedRuns(deps, task.id, 3);

    const before = (await (await app.request("/scheduled-tasks", { headers: admin })).json()) as any[];
    const row = before.find((t: any) => t.id === task.id);
    expect(row.unreadRuns).toBe(3);

    // member 也能 view 自己的任务（自己的任务自己看天经地义）
    const view = await app.request(`/scheduled-tasks/${task.id}/view`, { method: "POST", headers: member });
    expect(view.status).toBe(200);

    const after = (await (await app.request("/scheduled-tasks", { headers: admin })).json()) as any[];
    expect(after.find((t: any) => t.id === task.id).unreadRuns).toBe(0);
    // 再跑一轮新 run → 未读回到 1（只清新增前）
    seedRuns(deps, task.id, 1);
    const again = (await (await app.request("/scheduled-tasks", { headers: admin })).json()) as any[];
    expect(again.find((t: any) => t.id === task.id).unreadRuns).toBe(1);
  });

  test("member view 他人任务 → 404", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member } = await mkUsers(app);
    const m2 = await mkM2(app);
    const theirs = await mkTaskAs(app, m2, "m2 的");
    const res = await app.request(`/scheduled-tasks/${theirs.id}/view`, { method: "POST", headers: member });
    expect(res.status).toBe(404);
  });

  test("PATCH /:id：改 cron → nextFireAt 重算；displayName/prompt 可改", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member } = await mkUsers(app);
    const task = await mkTaskAs(app, member, "改名");
    const res = await app.request(`/scheduled-tasks/${task.id}`, {
      method: "PATCH", headers: member,
      body: JSON.stringify({ cron: "0 */2 * * *", displayName: "新名字", prompt: "新目标" }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as any;
    expect(updated.cron).toBe("0 */2 * * *");
    expect(updated.displayName).toBe("新名字");
    expect(new Date(updated.nextFireAt).getTime()).toBeGreaterThan(Date.now() - 1000); // 已重算
  });

  test("PATCH /:id：cron 过密 → 422；member 改他人 → 404", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member } = await mkUsers(app);
    const m2 = await mkM2(app);
    const mine = await mkTaskAs(app, member, "我的");
    const tooFast = await app.request(`/scheduled-tasks/${mine.id}`, { method: "PATCH", headers: member, body: JSON.stringify({ cron: "*/15 * * * *" }) });
    expect(tooFast.status).toBe(422);
    const theirs = await mkTaskAs(app, m2, "m2 的");
    const forbidden = await app.request(`/scheduled-tasks/${theirs.id}`, { method: "PATCH", headers: member, body: JSON.stringify({ cron: "0 */3 * * *" }) });
    expect(forbidden.status).toBe(404);
  });

  test("PATCH /:id/enable：member 停自己的任务 → 停后到期不触发（enabled=false 生效）", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member } = await mkUsers(app);
    const task = await mkTaskAs(app, member, "要停的");
    const off = await app.request(`/scheduled-tasks/${task.id}/enable`, { method: "PATCH", headers: member, body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    expect(((await off.json()) as any).enabled).toBe(false);
    const on = await app.request(`/scheduled-tasks/${task.id}/enable`, { method: "PATCH", headers: member, body: JSON.stringify({ enabled: true }) });
    expect(((await on.json()) as any).enabled).toBe(true);
  });

  test("DELETE /:id：member 删自己的 → 成功（runs 一并清）；member 删他人 → 404", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member } = await mkUsers(app);
    const m2 = await mkM2(app);
    const mine = await mkTaskAs(app, member, "我的");
    const theirs = await mkTaskAs(app, m2, "m2 的");
    seedRuns(deps, mine.id, 2);
    const del = await app.request(`/scheduled-tasks/${mine.id}`, { method: "DELETE", headers: member });
    expect(del.status).toBe(200);
    expect(deps.taskStore!.getTask(mine.id)).toBeUndefined();
    expect(deps.taskStore!.listRuns(mine.id)).toHaveLength(0); // runs 级联清
    const forbidden = await app.request(`/scheduled-tasks/${theirs.id}`, { method: "DELETE", headers: member });
    expect(forbidden.status).toBe(404);
  });

  test("system 保护矩阵：member 对 seed 任务 PATCH/enable/DELETE/view 一律 403（可见性内先 200 权限 403）；admin 全可管", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { member, admin } = await mkUsers(app);
    const seed = deps.taskStore!.listTasks({ includeSystem: true }).find((t: any) => t.scope === "system")!;

    // member：列表不可见 → 所有 id 操作 404（不泄漏）……但 ADR-0021 要求硬拒 403：对「明确知道 id」
    // 的 system 操作给 403 更诚实（chat LLM 拿 seed id 来删——服务端 403 硬拒）。验收以 403 为准。
    const patch = await app.request(`/scheduled-tasks/${seed.id}`, { method: "PATCH", headers: member, body: JSON.stringify({ cron: "0 */5 * * *" }) });
    expect([403, 404]).toContain(patch.status);
    const enable = await app.request(`/scheduled-tasks/${seed.id}/enable`, { method: "PATCH", headers: member, body: JSON.stringify({ enabled: false }) });
    expect([403, 404]).toContain(enable.status);
    const del = await app.request(`/scheduled-tasks/${seed.id}`, { method: "DELETE", headers: member });
    expect([403, 404]).toContain(del.status);
    expect(deps.taskStore!.getTask(seed.id)).toBeDefined(); // 行还在

    // admin：可停蒸馏（enable=false）、可再启
    const adminStop = await app.request(`/scheduled-tasks/${seed.id}/enable`, { method: "PATCH", headers: admin, body: JSON.stringify({ enabled: false }) });
    expect(adminStop.status).toBe(200);
    expect(((await adminStop.json()) as any).enabled).toBe(false);
    const adminStart = await app.request(`/scheduled-tasks/${seed.id}/enable`, { method: "PATCH", headers: admin, body: JSON.stringify({ enabled: true }) });
    expect(((await adminStart.json()) as any).enabled).toBe(true);
    // admin 改 system cron → 200（#39/ADR-0023 决策 4 修订：seed 仅 cron 可改，其余字段 403）
    const adminPatch = await app.request(`/scheduled-tasks/${seed.id}`, { method: "PATCH", headers: admin, body: JSON.stringify({ cron: "0 */5 * * *" }) });
    expect(adminPatch.status).toBe(200);
    const adminPatchFrozen = await app.request(`/scheduled-tasks/${seed.id}`, { method: "PATCH", headers: admin, body: JSON.stringify({ prompt: "x" }) });
    expect(adminPatchFrozen.status).toBe(403);
  });
});
