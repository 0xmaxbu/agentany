// 反馈路由测试（ADR-0008 多态反馈）。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import type { RunDeps } from "../src/runs";

const newDeps = (): RunDeps => ({ store: new WorkflowStore(openDbMigrated(":memory:")) });
const JH = { "content-type": "application/json" };

describe("feedback 路由", () => {
  test("POST + GET /feedback/:kind/:id", async () => {
    const app = createApp(newDeps());
    const post = await app.request("/feedback/workflow_run/r1", {
      method: "POST", headers: JH, body: JSON.stringify({ text: "很好", rating: 5 }),
    });
    expect(post.status).toBe(201);
    const get = await app.request("/feedback/workflow_run/r1");
    expect(get.status).toBe(200);
    const list = (await get.json()) as any;
    expect(list.length).toBe(1);
    expect(list[0].text).toBe("很好");
    expect(list[0].rating).toBe(5);
    expect(list[0].targetKind).toBe("workflow_run");
    expect(list[0].targetId).toBe("r1");
  });

  test("缺 text → 400；rating 越界 → 400", async () => {
    const app = createApp(newDeps());
    const noText = await app.request("/feedback/workflow_run/r1", { method: "POST", headers: JH, body: JSON.stringify({ rating: 3 }) });
    expect(noText.status).toBe(400);
    const badRating = await app.request("/feedback/workflow_run/r1", { method: "POST", headers: JH, body: JSON.stringify({ text: "x", rating: 9 }) });
    expect(badRating.status).toBe(400);
  });

  test("多态：chat targetKind 也能存", async () => {
    const app = createApp(newDeps());
    const post = await app.request("/feedback/chat/c1", { method: "POST", headers: JH, body: JSON.stringify({ text: "对话反馈" }) });
    expect(post.status).toBe(201);
    const list = (await (await app.request("/feedback/chat/c1")).json()) as any;
    expect(list.length).toBe(1);
    expect(list[0].targetKind).toBe("chat");
  });
});
