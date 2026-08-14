// 安全 hotfix 回归（h1 workspaceId/h2 input/h5 token+body/h7 resume 竞态/h8 runId）。
// 见 docs/adr/0009 + 安全审查合并清单；LIVE 代码层堵漏。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import type { RunDeps } from "../src/runs";
import { fullDeps } from "./deps";

const JH = { "content-type": "application/json" };
function newApp() {
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  const runPiFactory: RunDeps["runPiFactory"] = () =>
    async () => ({ text: "[stub]", messages: [], toolResults: [] });
  return createApp(fullDeps(store, { runPiFactory }));
}

describe("security hotfix · h1 workspaceId 校验（ADR-0018）", () => {
  test("坏 workspaceId（穿越/绝对/空格/超长/点）→ 400", async () => {
    const app = newApp();
    for (const wid of ["../x", "../../etc", "/etc", "a/b", "a b", "a.b", "a\\b", "a".repeat(65)]) {
      const r = await app.request("/workflows/synthetic-3step/runs", {
        method: "POST", headers: JH, body: JSON.stringify({ workspaceId: wid, input: {} }),
      });
      expect(r.status, `workspaceId=${JSON.stringify(wid)}`).toBe(400);
    }
  });
  test("好 workspaceId（缺省公司 ws）放行；projectId 字段废止 → 404", async () => {
    const app = newApp();
    const r = await app.request("/workflows/synthetic-3step/runs", {
      method: "POST", headers: JH, body: JSON.stringify({ input: {} }),
    });
    expect(r.status).toBe(200);
    const r2 = await app.request("/workflows/synthetic-3step/runs", {
      method: "POST", headers: JH, body: JSON.stringify({ projectId: "dev", input: {} }),
    });
    expect(r2.status).toBe(404);
  });
});

describe("security hotfix · h2 input 校验", () => {
  test("brand-research 缺 brand → 400（不触达 runPi）", async () => {
    const app = newApp();
    const r = await app.request("/workflows/brand-research/runs", {
      method: "POST", headers: JH, body: JSON.stringify({ input: {} }),
    });
    expect(r.status).toBe(400);
  });
  test("brand-research brand 非法类型 → 400", async () => {
    const app = newApp();
    const r = await app.request("/workflows/brand-research/runs", {
      method: "POST", headers: JH, body: JSON.stringify({ input: { brand: 123 } }),
    });
    expect(r.status).toBe(400);
  });
});

describe("security hotfix · h8 强 runId", () => {
  test("runId = r_<UUID>", async () => {
    const app = newApp();
    const r = await app.request("/workflows/synthetic-3step/runs", {
      method: "POST", headers: JH, body: JSON.stringify({ input: {} }),
    });
    const runId = ((await r.json()) as any).runId;
    expect(runId).toMatch(/^r_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("security hotfix · h7 并发 resume 不双执行", () => {
  test("两次并发 resume → log 无重复", async () => {
    const app = newApp();
    const start = await app.request("/workflows/synthetic-3step/runs", {
      method: "POST", headers: JH, body: JSON.stringify({ input: {} }),
    });
    const runId = ((await start.json()) as any).runId;
    const body = JSON.stringify({ resumeData: { decision: "accept" } });
    await Promise.all([
      app.request(`/runs/${runId}/resume`, { method: "POST", headers: JH, body }),
      app.request(`/runs/${runId}/resume`, { method: "POST", headers: JH, body }),
    ]);
    const g = await app.request(`/runs/${runId}`);
    const gb = (await g.json()) as any;
    const completed = gb.log.filter((e: any) => e.status === "completed").map((e: any) => e.stepId);
    expect(completed.join(",")).toBe("s1,review,s2"); // 无 review/s2 重复
  });
});

describe("security hotfix · h5 body 上限 + dev token", () => {
  test("超 64KB body → 413（真 fetch 带 content-length → 中间件卡）", async () => {
    const app = newApp();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/workflows/synthetic-3step/runs`, {
        method: "POST", headers: JH, body: "x".repeat(100_000),
      });
      expect(r.status).toBe(413);
    } finally {
      server.stop(true);
    }
  });
  test("设了 AGENTANY_DEV_TOKEN：无 Bearer → 401，有 → 200", async () => {
    process.env.AGENTANY_DEV_TOKEN = "test-secret";
    try {
      const app = newApp();
      const no = await app.request("/workflows");
      expect(no.status).toBe(401);
      const yes = await app.request("/workflows", { headers: { authorization: "Bearer test-secret" } });
      expect(yes.status).toBe(200);
    } finally {
      delete process.env.AGENTANY_DEV_TOKEN;
    }
  });
  test("未设 token：放行（dev）", async () => {
    delete process.env.AGENTANY_DEV_TOKEN;
    const app = newApp();
    const r = await app.request("/workflows");
    expect(r.status).toBe(200);
  });
});
