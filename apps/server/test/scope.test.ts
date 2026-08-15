// workspace scope（ADR-0018）：ws_company→general（data/general）、其余→workspace（data/workspaces/<id>）。
// 含：路径解析 + 防注入 + 路由建会话缺省公司 ws + general 会话跑通 turn。
import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { resolveScopePaths, scopeOf } from "../src/scope";
import { DATA_DIR } from "../src/config";
import { WorkflowStore } from "../src/workflow-engine/store";
import { openDbMigrated } from "../src/db/client";
import { createApp } from "../src/app";
import { makeRunPiStream, type ConfiguredRunPiStream } from "../src/pi/runPi-factory";
import { fullDeps } from "./deps";

const JH = { "content-type": "application/json" };

describe("scope.scopeOf", () => {
  test("公司 ws → general；其余 → workspace", () => {
    expect(scopeOf("ws_company")).toBe("general");
    expect(scopeOf("ws_abc123")).toBe("workspace");
    expect(scopeOf(null)).toBe("workspace"); // 非 general 皆 workspace（null 无目录——resolveScopePaths 会抛）
  });
});

describe("scope.resolveScopePaths", () => {
  test("general（公司 ws）→ data/general/{workspace,pi-sessions}", () => {
    const p = resolveScopePaths("general");
    expect(p.cwd).toBe(resolve(DATA_DIR, "general", "workspace"));
    expect(p.sessionDir).toBe(resolve(DATA_DIR, "general", "pi-sessions"));
  });

  test("workspace + 合法 id → data/workspaces/<id>/{workspace,pi-sessions}", () => {
    const p = resolveScopePaths("workspace", "ws_acme");
    expect(p.cwd).toBe(resolve(DATA_DIR, "workspaces", "ws_acme", "workspace"));
    expect(p.sessionDir).toBe(resolve(DATA_DIR, "workspaces", "ws_acme", "pi-sessions"));
  });

  test("workspace + 穿越串 → 抛（h1 路径防注入）", () => {
    expect(() => resolveScopePaths("workspace", "../etc")).toThrow();
    expect(() => resolveScopePaths("workspace", "/abs/path")).toThrow();
  });

  test("workspace + 缺 id → 抛", () => {
    expect(() => resolveScopePaths("workspace", undefined)).toThrow();
    expect(() => resolveScopePaths("workspace", null)).toThrow();
  });
});

// makeRunPiStream 构造时即按 scope 解析路径（公司 ws → general，不抛；非法 → 抛）。
// 闭包不调用 → 不 spawn 真 pi；只验解析路由正确。
describe("scope.runPi-factory 按 scope 解析", () => {
  test("workspaceId=公司 ws（general）构造不抛", () => {
    expect(() => makeRunPiStream({ workspaceId: "ws_company", sessionId: "chat-x" })).not.toThrow();
  });
  test("workspaceId=合法 ws（workspace）构造不抛", () => {
    expect(() => makeRunPiStream({ workspaceId: "ws_acme", sessionId: "chat-x" })).not.toThrow();
  });
  test("workspaceId=穿越串（workspace）构造抛", () => {
    expect(() => makeRunPiStream({ workspaceId: "../etc", sessionId: "chat-x" })).toThrow();
  });
});

// DB：conversations.workspaceId 恒非空（缺省公司 ws）。
describe("scope.DB workspaceId", () => {
  test("createConversation(公司 ws) → 回读一致", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u", title: "g" });
    const conv = store.getConversation("c1");
    expect(conv).toBeTruthy();
    expect(conv!.workspaceId).toBe("ws_company");
  });

  test("createConversation(自定义 ws) → 回读一致", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c2", workspaceId: "ws_acme", userId: "u" });
    expect(store.getConversation("c2")!.workspaceId).toBe("ws_acme");
  });
});

// 路由：建会话缺省公司 ws；projectId 字段废止；非法 workspaceId 400。
function newApp() {
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  const deps = fullDeps(store);
  return { app: createApp(deps), store };
}

describe("scope.路由建会话", () => {
  test("无 workspaceId → 201 + ws_company（缺省公司 ws）", async () => {
    const { app } = newApp();
    const r = await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) });
    expect(r.status).toBe(201);
    const conv: any = await r.json();
    expect(conv.workspaceId).toBe("ws_company");
  });

  test("projectId 字段废止：携带即 404（不落悬空锚）", async () => {
    const { app } = newApp();
    const r = await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({ projectId: "dev" }) });
    expect(r.status).toBe(404);
  });

  test("workspaceId=穿越串 → 400", async () => {
    const { app } = newApp();
    const r = await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({ workspaceId: "../etc" }) });
    expect(r.status).toBe(400);
  });

  test("workspaceId=存在但无权（非成员 ws，dev-admin 全通例外见 workspace-authz）→ 此处全库仅 seed 公司 ws，自定义 ws 不存在 → 404", async () => {
    const { app } = newApp();
    const r = await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({ workspaceId: "ws_nope" }) });
    expect(r.status).toBe(404);
  });
});

describe("scope.公司 ws 会话跑通 turn（事件驱动 / ticket #13）", () => {
  test("公司 ws 会话 POST message(202) → 持久流收 delta→done", async () => {
    const echo = (): ConfiguredRunPiStream => async (call) => {
      call.onBlock?.({ op: "start", blockId: "b1", kind: "text" });
      call.onBlock?.({ op: "delta", blockId: "b1", delta: call.prompt });
      call.onBlock?.({ op: "end", blockId: "b1" });
      return { text: call.prompt, messages: [], toolResults: [] };
    };
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    const deps = fullDeps(store, { runPiStreamFactory: echo });
    const app = createApp(deps);

    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    expect(c.workspaceId).toBe("ws_company");

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
    expect(frames.filter((f: any) => f.type === "block_delta").map((f: any) => f.delta).join("")).toBe("hi-general");
    expect(frames.at(-1)!.type).toBe("done");
  });
});
