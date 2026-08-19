// T4（#53）：run 卡刷新恢复——GET /conversations/:id/runs 域表直读（workflow_runs + workflow_run_log）。
// seam：HTTP（会话可见性守卫同 /messages 口径）+ 直查 store 对照；步骤收敛（log 每步取最新态）单测在 store 层。
import { describe, test, expect, beforeEach } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };

async function setup() {
  const db = openDbMigrated(":memory:");
  const store = createStores(db);
  const userStore = new UserStore(db);
  const deps: RunDeps = {
    runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore, streamRegistry: new StreamRegistry(), workspaceStore: new WorkspaceStore(db),
  };
  await userStore.createUser({ username: "m1", password: "pw-long-enough", role: "member" });
  await userStore.createUser({ username: "m2", password: "pw-long-enough", role: "member" });
  const m1 = userStore.getUserByUsername("m1")!;
  const m2 = userStore.getUserByUsername("m2")!;
  const app = createApp(deps);
  const login = async (u: string) => {
    const r = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: u, password: "pw-long-enough" }) });
    return `Bearer ${(await r.json() as any).token}`;
  };
  return { deps, store, userStore, app, m1, m2, login };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });

describe("GET /conversations/:id/runs（#53/T4）", () => {
  function seedRun(runId: string, workflowId: string, convId: string, status: "running" | "completed", brief?: string) {
    ctx.store.runs.createRun({ runId, workflowId, workspaceId: "ws_company", conversationId: convId, input: {} });
    if (status === "completed") {
      ctx.store.runs.updateRunStatus(runId, "completed");
      if (brief) ctx.store.runs.setTerminalBrief({ runId, status: "completed", brief, messageContent: "", conversationId: convId }); // messageContent 空 → 不写气泡
    }
    return runId;
  }

  test("按会话返 run 列表（runId/status/workflowId/steps/brief）；空会话 → []", async () => {
    ctx.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: ctx.m1.id });
    ctx.store.chat.createConversation({ id: "c2", workspaceId: "ws_company", userId: ctx.m1.id });
    seedRun("r_completed", "synthetic-3step", "c1", "completed", "简报：完成");
    seedRun("r_suspended", "brand-research", "c1", "running");
    // c2 无 run
    const token = await ctx.login("m1");
    const r = await ctx.app.request("/conversations/c1/runs", { headers: { authorization: token } });
    expect(r.status).toBe(200);
    const { runs } = await r.json() as { runs: any[] };
    expect(runs).toHaveLength(2);
    const completed = runs.find((x) => x.runId === "r_completed");
    expect(completed).toMatchObject({ workflowId: "synthetic-3step", status: "completed", brief: "简报：完成", steps: [] });
    expect(runs.find((x) => x.runId === "r_suspended").status).toBe("running");
    const empty = await ctx.app.request("/conversations/c2/runs", { headers: { authorization: token } });
    expect(((await empty.json()) as any).runs).toEqual([]);
  });

  test("步骤从 log 收敛：同一步多次状态取最新（running→completed），不同步保出现序", async () => {
    ctx.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: ctx.m1.id });
    ctx.store.runs.createRun({ runId: "r_log", workflowId: "wf-x", workspaceId: "ws_company", conversationId: "c1", input: {} });
    ctx.store.runs.appendLog("r_log", { stepId: "review", status: "running" });
    ctx.store.runs.appendLog("r_log", { stepId: "s1", status: "running" });
    ctx.store.runs.appendLog("r_log", { stepId: "review", status: "completed" }); // review 终态覆盖
    ctx.store.runs.appendLog("r_log", { stepId: "s1", status: "completed" });
    const token = await ctx.login("m1");
    const r = await ctx.app.request("/conversations/c1/runs", { headers: { authorization: token } });
    const { runs } = await r.json() as { runs: any[] };
    const steps = runs[0].steps as { stepId: string; status: string }[];
    expect(steps).toEqual([
      { stepId: "review", status: "completed" },
      { stepId: "s1", status: "completed" },
    ]); // 最新态 + 首现序（无 review/running 重复）
  });

  test("鉴权：他人会话 / 不存在会话 → 404（错误隔离不泄漏存在）", async () => {
    ctx.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: ctx.m1.id }); // m1 私有
    const token2 = await ctx.login("m2");
    const other = await ctx.app.request("/conversations/c1/runs", { headers: { authorization: token2 } });
    expect(other.status).toBe(404); // m2 见不到 m1 的会话
    const missing = await ctx.app.request("/conversations/c_no-such/runs", { headers: { authorization: token2 } });
    expect(missing.status).toBe(404);
  });

  test("既有 GET /runs/:id（单 run）不受影响（回归护栏）", async () => {
    ctx.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: ctx.m1.id });
    seedRun("r_solo", "synthetic-3step", "c1", "completed", "简报");
    const token = await ctx.login("m1");
    const r = await ctx.app.request("/runs/r_solo", { headers: { authorization: token } });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.run.status).toBe("completed");
    expect(Array.isArray(body.log)).toBe(true);
  });
});