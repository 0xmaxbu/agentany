// 路由 e2e（Hono app.request，不打真端口；stub runPi factory；内存 sqlite）。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import type { RunDeps } from "../src/runs";
import { fullDeps } from "./deps";

function newDeps(): RunDeps {
  const store = createStores(openDbMigrated(":memory:"));
  // synthetic 是纯程序步、不调 runPi；工厂给个 stub 兜底。
  const runPiFactory: RunDeps["runPiFactory"] = () =>
    async () => ({ text: "[stub]", messages: [], toolResults: [] });
  return fullDeps(store, { runPiFactory });
}

const JSON_HEADERS = { "content-type": "application/json" };

describe("HTTP · 工作流路由", () => {
  test("list + start→suspend→resume→completed + get", async () => {
    const app = createApp(newDeps());

    const list = await app.request("/workflows");
    expect(list.status).toBe(200);
    const lb = await list.json();
    expect(Array.isArray(lb) && lb.some((w: any) => w.id === "synthetic-3step")).toBe(true);

    const start = await app.request("/workflows/synthetic-3step/runs", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ input: { offset: 0 } }),
    });
    expect(start.status).toBe(200);
    const sb = (await start.json()) as any;
    expect(sb.status).toBe("suspended");
    expect(sb.stepId).toBe("review");
    const runId = sb.runId;

    const res = await app.request(`/runs/${runId}/resume`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ resumeData: { decision: "accept" } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("completed");

    const get = await app.request(`/runs/${runId}`);
    expect(get.status).toBe(200);
    const gb = (await get.json()) as any;
    const completed = gb.log.filter((e: any) => e.status === "completed").map((e: any) => e.stepId);
    expect(completed.join(",")).toBe("s1,review,s2");
  });

  test("未知 workflow → 404", async () => {
    const app = createApp(newDeps());
    const r = await app.request("/workflows/nope/runs", { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect(r.status).toBe(404);
  });

  test("resume 校验失败 → 200 含 rejected（不改状态）", async () => {
    const app = createApp(newDeps());
    const start = await app.request("/workflows/synthetic-3step/runs", {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ input: { offset: 0 } }),
    });
    const runId = ((await start.json()) as any).runId;
    const bad = await app.request(`/runs/${runId}/resume`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ resumeData: { decision: "bogus" } }),
    });
    const bb = (await bad.json()) as any;
    expect(bb.rejected).toBe(true);
    expect(bb.status).toBe("suspended");
  });
});
