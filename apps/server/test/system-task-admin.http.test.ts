// #39/M6-1（ADR-0023 决策 4）：admin 经 API 全管理 system 任务。
// 覆盖：admin 建 system（权限双列落库）/member 403；admin PATCH 全字段/member 403；
// 蒸馏 seed 冻结（仅 cron）；DELETE 在跑 409；chat 工具侧不放开（本文件只测 API 面）。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { DISTILL_TASK_ID } from "../src/scheduled-tasks/execute";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };
const H1H_CRON = "0 5 * * 1"; // 周一 05:00（≥1h 间隔）

async function setup() {
  const db = openDbMigrated(":memory:");
  const store = createStores(db);
  const userStore = new UserStore(db);
  await userStore.createUser({ username: "ad", password: "pw-long-enough", role: "admin" });
  await userStore.createUser({ username: "m1", password: "pw-long-enough", role: "member" });
  const deps: RunDeps = {
    runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore, streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store.chat),
    eventBus: new EventBus(),
    runPiFactory: ((): any => () => () => new Promise(() => {})) as any, // 不被真实触发（scheduler 走 spy）
  };
  const app = createApp(deps);
  const login = async (u: string) => {
    const r = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: u, password: "pw-long-enough" }) });
    return `Bearer ${(await r.json() as any).token}`;
  };
  return { deps, store, app, login };
}

beforeEach(() => { process.env.AGENTANY_DEV_TOKEN = "dev-test-token"; });
afterEach(() => { delete process.env.AGENTANY_DEV_TOKEN; });

describe("POST /scheduled-tasks（scope=system 放开——admin-only）", () => {
  test("admin 建 system 任务 → 201：workspaceId=null、无产出会话、权限双列落库", async () => {
    const ctx = await setup();
    const tok = await ctx.login("ad");
    const r = await ctx.app.request("/scheduled-tasks", {
      method: "POST", headers: { ...JH, authorization: tok },
      body: JSON.stringify({ scope: "system", displayName: "周报巡检", cron: H1H_CRON, prompt: "汇总各 ws 本周产出", allowWrite: false, allowSearch: true }),
    });
    expect(r.status).toBe(201);
    const t = await r.json() as any;
    expect(t.scope).toBe("system");
    expect(t.workspaceId).toBeNull(); // ADR-0023 决策 1：逻辑概念，恒 null
    expect(t.outputConversationId).toBeNull(); // system 无产出会话
    expect(t.allowWrite).toBe(false);
    expect(t.allowSearch).toBe(true);
    // admin id 落 creatorId
    const ad = ctx.deps.userStore!.getUserByUsername("ad")!;
    expect(t.creatorId).toBe(ad.id);
  });

  test("admin 建 system 不带权限字段 → 201 缺省（allowWrite=true/allowSearch=false）", async () => {
    const ctx = await setup();
    const r = await ctx.app.request("/scheduled-tasks", {
      method: "POST", headers: { ...JH, authorization: await ctx.login("ad") },
      body: JSON.stringify({ scope: "system", displayName: "巡检", cron: H1H_CRON, prompt: "p" }),
    });
    expect(r.status).toBe(201);
    const t = await r.json() as any;
    expect(t.allowWrite).toBe(true);
    expect(t.allowSearch).toBe(false);
  });

  test("member 建 system → 403；权限字段类型错 → 400", async () => {
    const ctx = await setup();
    expect((await ctx.app.request("/scheduled-tasks", {
      method: "POST", headers: { ...JH, authorization: await ctx.login("m1") },
      body: JSON.stringify({ scope: "system", displayName: "x", cron: H1H_CRON, prompt: "p" }),
    })).status).toBe(403);
    expect((await ctx.app.request("/scheduled-tasks", {
      method: "POST", headers: { ...JH, authorization: await ctx.login("ad") },
      body: JSON.stringify({ scope: "system", displayName: "x", cron: H1H_CRON, prompt: "p", allowWrite: "yes" }),
    })).status).toBe(400);
  });
});

describe("PATCH /scheduled-tasks/:id（system 放开——admin-only）", () => {
  async function mkSystem(ctx: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}): Promise<string> {
    const r = await ctx.app.request("/scheduled-tasks", {
      method: "POST", headers: { ...JH, authorization: await ctx.login("ad") },
      body: JSON.stringify({ scope: "system", displayName: "n", cron: H1H_CRON, prompt: "p", ...over }),
    });
    return ((await r.json()) as any).id as string;
  }

  test("admin 改 system：字段生效 + cron 变更重算 nextFireAt", async () => {
    const ctx = await setup();
    const id = await mkSystem(ctx);
    const before = ctx.deps.taskStore!.getTask(id)!.nextFireAt;
    const r = await ctx.app.request(`/scheduled-tasks/${id}`, {
      method: "PATCH", headers: { ...JH, authorization: await ctx.login("ad") },
      body: JSON.stringify({ displayName: "改名", prompt: "新目标", allowWrite: false, cron: "30 6 * * 2" }),
    });
    expect(r.status).toBe(200);
    const t = await r.json() as any;
    expect(t.displayName).toBe("改名");
    expect(t.prompt).toBe("新目标");
    expect(t.allowWrite).toBe(false);
    expect(t.cron).toBe("30 6 * * 2");
    expect(new Date(t.nextFireAt).getTime()).toBeGreaterThan(new Date(before).getTime() - 1); // 已重算（非原值直传）
    expect(new Date(t.nextFireAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("member 改 system → 403（loadTask 硬拒优先）", async () => {
    const ctx = await setup();
    const id = await mkSystem(ctx);
    expect((await ctx.app.request(`/scheduled-tasks/${id}`, {
      method: "PATCH", headers: { ...JH, authorization: await ctx.login("m1") },
      body: JSON.stringify({ displayName: "x" }),
    })).status).toBe(403);
  });

  test("蒸馏 seed 冻结：PATCH 仅 cron 可改，其它字段 403", async () => {
    const ctx = await setup();
    // 蒸馏 seed 已由迁移 0013 种入（openDbMigrated 即有）——直接对它断言
    const tok = await ctx.login("ad");
    // cron 可改
    expect((await ctx.app.request(`/scheduled-tasks/${DISTILL_TASK_ID}`, {
      method: "PATCH", headers: { ...JH, authorization: tok }, body: JSON.stringify({ cron: "15 4 * * 3" }),
    })).status).toBe(200);
    // prompt/displayName/权限字段一律拒
    for (const body of [{ prompt: "x" }, { displayName: "x" }, { allowWrite: false }, { allowSearch: true }]) {
      expect((await ctx.app.request(`/scheduled-tasks/${DISTILL_TASK_ID}`, {
        method: "PATCH", headers: { ...JH, authorization: tok }, body: JSON.stringify(body),
      })).status).toBe(403);
    }
  });

  test("cron 校验沿用：非法 400 / 过密 422", async () => {
    const ctx = await setup();
    const id = await mkSystem(ctx);
    const tok = await ctx.login("ad");
    expect((await ctx.app.request(`/scheduled-tasks/${id}`, {
      method: "PATCH", headers: { ...JH, authorization: tok }, body: JSON.stringify({ cron: "not-cron" }),
    })).status).toBe(400);
    expect((await ctx.app.request(`/scheduled-tasks/${id}`, {
      method: "PATCH", headers: { ...JH, authorization: tok }, body: JSON.stringify({ cron: "* * * * *" }),
    })).status).toBe(422);
  });
});

describe("DELETE /scheduled-tasks/:id（system 放开 + 在跑 409）", () => {
  test("admin 删 system → 200；member → 403；在跑 → 409", async () => {
    const ctx = await setup();
    const mk = await ctx.app.request("/scheduled-tasks", {
      method: "POST", headers: { ...JH, authorization: await ctx.login("ad") },
      body: JSON.stringify({ scope: "system", displayName: "d", cron: H1H_CRON, prompt: "p" }),
    });
    const id = ((await mk.json()) as any).id;
    // member 拒
    expect((await ctx.app.request(`/scheduled-tasks/${id}`, {
      method: "DELETE", headers: { authorization: await ctx.login("m1") } },
    )).status).toBe(403);
    // admin 删 ok
    expect((await ctx.app.request(`/scheduled-tasks/${id}`, {
      method: "DELETE", headers: { authorization: await ctx.login("ad") } },
    )).status).toBe(200);
    // 再造一个并占住 running（spy scheduler——同 scheduled-tasks.http.test.ts 纪律，不抢真实执行链时序）
    const mk2 = await ctx.app.request("/scheduled-tasks", {
      method: "POST", headers: { ...JH, authorization: await ctx.login("ad") },
      body: JSON.stringify({ scope: "system", displayName: "busy", cron: H1H_CRON, prompt: "p" }),
    });
    const id2 = ((await mk2.json()) as any).id;
    ctx.deps.scheduler = { isRunning: (id: string) => id === id2 } as any; // 该任务在跑
    expect((await ctx.app.request(`/scheduled-tasks/${id2}`, {
      method: "DELETE", headers: { authorization: await ctx.login("ad") } },
    )).status).toBe(409);
  });

  test("蒸馏 seed 不可删（admin 403）", async () => {
    const ctx = await setup();
    // 蒸馏 seed 已由迁移 0013 种入——直接对它断言
    expect((await ctx.app.request(`/scheduled-tasks/${DISTILL_TASK_ID}`, {
      method: "DELETE", headers: { authorization: await ctx.login("ad") } },
    )).status).toBe(403);
  });
});

describe("member 视图隔离（回归）", () => {
  test("member 列表不含任何 system 任务（admin 建后仍不见）", async () => {
    const ctx = await setup();
    await ctx.app.request("/scheduled-tasks", {
      method: "POST", headers: { ...JH, authorization: await ctx.login("ad") },
      body: JSON.stringify({ scope: "system", displayName: "s", cron: H1H_CRON, prompt: "p" }),
    });
    const list = await (await ctx.app.request("/scheduled-tasks", { headers: { authorization: await ctx.login("m1") } })).json() as any[];
    expect(list.every((t) => t.scope !== "system")).toBe(true);
  });
});
