// ticket #10 会话 scope：project / general 路径解析 + projectId 可空 + 路由建会话 + general 跑通 turn。
import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { resolveScopePaths, scopeOf } from "../src/scope";
import { DATA_DIR } from "../src/config";
import { WorkflowStore } from "../src/workflow-engine/store";
import { openDbMigrated } from "../src/db/client";
import { createApp } from "../src/app";
import { makeRunPiStream, type ConfiguredRunPiStream } from "../src/pi/runPi-factory";
import type { RunDeps } from "../src/runs";

const JH = { "content-type": "application/json" };

// scopeOf：projectId 非空 → project；空 → general。
describe("scope.scopeOf", () => {
  test("非空 → project；null/undefined/空串 → general", () => {
    expect(scopeOf("acme")).toBe("project");
    expect(scopeOf(null)).toBe("general");
    expect(scopeOf(undefined)).toBe("general");
    expect(scopeOf("")).toBe("general");
  });
});

// resolveScopePaths：两 scope 路径正确 + project 校验。
describe("scope.resolveScopePaths", () => {
  test("general → data/general/{workspace,pi-sessions}", () => {
    const p = resolveScopePaths("general");
    expect(p.cwd).toBe(resolve(DATA_DIR, "general", "workspace"));
    expect(p.sessionDir).toBe(resolve(DATA_DIR, "general", "pi-sessions"));
  });

  test("project + 合法 id → data/projects/<id>/{workspace,pi-sessions}", () => {
    const p = resolveScopePaths("project", "acme");
    expect(p.cwd).toBe(resolve(DATA_DIR, "projects", "acme", "workspace"));
    expect(p.sessionDir).toBe(resolve(DATA_DIR, "projects", "acme", "pi-sessions"));
  });

  test("project + 穿越串 → 抛（h1 路径防注入）", () => {
    expect(() => resolveScopePaths("project", "../etc")).toThrow();
    expect(() => resolveScopePaths("project", "/abs/path")).toThrow();
  });

  test("project + 缺 id → 抛", () => {
    expect(() => resolveScopePaths("project", undefined)).toThrow();
    expect(() => resolveScopePaths("project", null)).toThrow();
  });
});

// makeRunPiStream 构造时即按 scope 解析路径（projectId=null → general，不抛；非法 → 抛）。
// 闭包不调用 → 不 spawn 真 pi；只验解析路由正确。
describe("scope.runPi-factory 按 scope 解析", () => {
  test("projectId=null（general）构造不抛", () => {
    expect(() => makeRunPiStream({ projectId: null, sessionId: "chat-x" })).not.toThrow();
  });
  test("projectId=合法（project）构造不抛", () => {
    expect(() => makeRunPiStream({ projectId: "acme", sessionId: "chat-x" })).not.toThrow();
  });
  test("projectId=穿越串（project）构造抛", () => {
    expect(() => makeRunPiStream({ projectId: "../etc", sessionId: "chat-x" })).toThrow();
  });
});

// DB：conversations.projectId 可空。
describe("scope.DB projectId 可空", () => {
  test("createConversation(null) → getConversation 返 null", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", projectId: null, userId: "u", title: "g" });
    const conv = store.getConversation("c1");
    expect(conv).toBeTruthy();
    expect(conv!.projectId).toBeNull();
  });

  test("createConversation('dev') → 返 'dev'", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c2", projectId: "dev", userId: "u" });
    expect(store.getConversation("c2")!.projectId).toBe("dev");
  });
});

// 路由：建 general / project / 非法。
function newApp() {
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  const deps: RunDeps = { store };
  return { app: createApp(deps), store };
}

describe("scope.路由建会话", () => {
  test("无 projectId → 201 + projectId=null（general）", async () => {
    const { app } = newApp();
    const r = await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) });
    expect(r.status).toBe(201);
    const conv: any = await r.json();
    expect(conv.projectId).toBeNull();
  });

  test("projectId=dev → 201 + projectId='dev'（project）", async () => {
    const { app } = newApp();
    const r = await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({ projectId: "dev" }) });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).projectId).toBe("dev");
  });

  test("projectId=穿越串 → 400", async () => {
    const { app } = newApp();
    const r = await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({ projectId: "../etc" }) });
    expect(r.status).toBe(400);
  });
});

describe("scope.general 会话跑通 turn（事件驱动 / ticket #13）", () => {
  test("general 会话 POST message(202) → 持久流收 delta→done", async () => {
    const echo = (): ConfiguredRunPiStream => async (call) => {
      call.onDelta(call.prompt);
      return { text: call.prompt, messages: [], toolResults: [] };
    };
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    const deps: RunDeps = { store, runPiStreamFactory: echo };
    const app = createApp(deps);

    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    expect(c.projectId).toBeNull(); // general

    // 开持久流（首个 read 触发 streamSSE callback→订阅）
    const streamResp = await app.request(`/conversations/${c.id}/stream`);
    const reader = streamResp.body!.getReader();
    const frames: any[] = [];
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              try { frames.push(JSON.parse(line.slice(6))); } catch { /* */ }
            }
          }
        }
      }
    })().catch(() => {});

    await new Promise<void>((r) => setTimeout(r, 15)); // 确保已订阅
    const r = await app.request(`/conversations/${c.id}/messages`, { method: "POST", headers: JH, body: JSON.stringify({ content: "hi-general" }) });
    expect(r.status).toBe(202);
    const start = Date.now();
    while (Date.now() - start < 3000 && !frames.some((f) => f.type === "done")) {
      await new Promise<void>((res) => setTimeout(res, 15));
    }
    await reader.cancel();
    expect(frames.filter((f) => f.type === "delta").map((f) => f.text).join("")).toBe("hi-general");
    expect(frames.at(-1)!.type).toBe("done");
  });
});
