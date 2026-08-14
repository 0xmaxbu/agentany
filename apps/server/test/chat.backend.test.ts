// 切片② chat 后端（ADR-0009 / ticket #13）：事件驱动——POST /messages=202 ACK + 持久流 GET /stream。
// DI：注入 runPiStreamFactory stub 吐确定性 delta；不打真 pi。
// 测试范式：开 /stream（后台读循环）→ POST(202) → 从流收 user_message/delta/done。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { fullDeps } from "./deps";
import type { ConfiguredRunPiStream } from "../src/pi/runPi-factory";

const JH = { "content-type": "application/json" };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await delay(15);
  }
};

// 开持久流：后台读循环累积帧（首个 read 触发 streamSSE callback→订阅）。reader.cancel() 终止。
async function openStream(app: ReturnType<typeof createApp>, convId: string) {
  const resp = await app.request(`/conversations/${convId}/stream`);
  const reader = resp.body!.getReader();
  const frames: any[] = [];
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value!, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            try { frames.push(JSON.parse(line.slice(6))); } catch { /* 非 JSON */ }
          }
        }
      }
    }
  })().catch(() => {});
  return { frames, reader };
}

// 计数 factory：观测并发活跃数（验 FIFO 串行 vs 跨会话并行）。
function countingFactory(): { factory: () => ConfiguredRunPiStream; maxActive: () => number } {
  let active = 0, max = 0;
  return {
    factory: () => async (call) => {
      active++; max = Math.max(max, active);
      try {
        for (const t of (call.prompt.match(/.{1,3}/g) ?? [call.prompt])) {
          call.onDelta(t);
          await delay(10);
        }
        return { text: call.prompt, messages: [], toolResults: [] };
      } finally { active--; }
    },
    maxActive: () => max,
  };
}

function newApp(streamFactory: () => ConfiguredRunPiStream) {
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  const deps = fullDeps(store, { runPiStreamFactory: streamFactory });
  return { app: createApp(deps), store };
}

const postMsg = (app: ReturnType<typeof createApp>, id: string, content: string) =>
  app.request(`/conversations/${id}/messages`, { method: "POST", headers: JH, body: JSON.stringify({ content }) });

describe("chat 切片② · 建会话 + 历史", () => {
  test("POST /conversations → 201；GET messages 初始 []", async () => {
    const { app } = newApp(countingFactory().factory);
    const r = await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({ projectId: "dev", title: "t1" }) });
    expect(r.status).toBe(201);
    const conv: any = await r.json();
    expect(conv.id).toBeTruthy();
    const h = await app.request(`/conversations/${conv.id}/messages`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual([]);
  });

  test("GET 不存在的会话 → 404", async () => {
    const { app } = newApp(countingFactory().factory);
    expect((await app.request("/conversations/nope/messages")).status).toBe(404);
  });
});

describe("chat 切片② · 事件驱动（POST=202 + 持久流）", () => {
  test("POST message → 202；流收 user_message + delta...done；GET 含 user+assistant", async () => {
    const { app } = newApp(countingFactory().factory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({ projectId: "dev" }) })).json();
    const s = await openStream(app, c.id);
    await delay(15); // 确保流已订阅（首个 read 触发 streamSSE callback）

    const r = await postMsg(app, c.id, "HelloWorld");
    expect(r.status).toBe(202);

    await delayUntil(() => s.frames.some((f) => f.type === "done"));
    const deltas = s.frames.filter((f) => f.type === "delta").map((f) => f.text).join("");
    expect(deltas).toBe("HelloWorld");
    expect(s.frames.some((f) => f.type === "user_message" && f.content === "HelloWorld")).toBe(true);
    expect(s.frames.some((f) => f.type === "done")).toBe(true);
    await s.reader.cancel();

    const msgs: any = await (await app.request(`/conversations/${c.id}/messages`)).json();
    expect(msgs.map((m: any) => [m.role, m.content])).toEqual([["user", "HelloWorld"], ["assistant", "HelloWorld"]]);
  });

  test("空 content → 400", async () => {
    const { app } = newApp(countingFactory().factory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    expect((await postMsg(app, c.id, "")).status).toBe(400);
  });
});

describe("chat 切片② · per-conversation FIFO 串行", () => {
  test("同会话并发两条 turn → maxActive===1；两条各自完整不污染", async () => {
    const cf = countingFactory();
    const { app } = newApp(cf.factory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    const s = await openStream(app, c.id);
    await delay(15);
    await postMsg(app, c.id, "AAAA");
    await postMsg(app, c.id, "BBBB");
    await delayUntil(() => s.frames.filter((f) => f.type === "done").length >= 2);
    expect(cf.maxActive()).toBe(1); // 串行
    const dones = s.frames.filter((f) => f.type === "done");
    expect(dones.map((f) => f.text)).toEqual(["AAAA", "BBBB"]); // 各自完整、不交叉
    await s.reader.cancel();
  });
});

describe("chat 切片② · 跨会话并行", () => {
  test("两会话并发 turn → maxActive===2（并行不互锁）", async () => {
    const cf = countingFactory();
    const { app } = newApp(cf.factory);
    const c1: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    const c2: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    const s1 = await openStream(app, c1.id);
    const s2 = await openStream(app, c2.id);
    await delay(15);
    await postMsg(app, c1.id, "XXXX");
    await postMsg(app, c2.id, "YYYY");
    await delayUntil(() => s1.frames.some((f) => f.type === "done") && s2.frames.some((f) => f.type === "done"));
    expect(cf.maxActive()).toBe(2);
    await s1.reader.cancel();
    await s2.reader.cancel();
  });
});

describe("chat 切片② · abort", () => {
  test("abort 当前 turn → 流以 done.aborted 收尾、不写助手消息", async () => {
    const hangFactory = (): ConfiguredRunPiStream => async (call) => {
      call.onDelta("partial-");
      if (call.signal) {
        await new Promise<void>((res) => {
          const t = setTimeout(res, 30000);
          call.signal!.addEventListener("abort", () => { clearTimeout(t); res(); });
        });
      }
      return { text: "partial-", messages: [], toolResults: [] };
    };
    const { app } = newApp(hangFactory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    const s = await openStream(app, c.id);
    await delay(15);
    await postMsg(app, c.id, "hi");
    await delay(30); // 让 turn 起来
    const ab = await app.request(`/conversations/${c.id}/abort`, { method: "POST" });
    expect(ab.status).toBe(200);
    await delayUntil(() => s.frames.some((f) => f.type === "done"));
    const last = s.frames.at(-1);
    expect(last?.type).toBe("done");
    expect(last?.aborted).toBe(true);
    await s.reader.cancel();
    const msgs: any = await (await app.request(`/conversations/${c.id}/messages`)).json();
    expect(msgs.map((m: any) => m.role)).toEqual(["user"]); // abort 不写助手消息
  });
});

describe("chat 切片② · 队列上限 429", () => {
  test("同会话 pending > 5 → 第 6 条 429", async () => {
    const slowFactory = (): ConfiguredRunPiStream => async (call) => {
      call.onDelta("x");
      await delay(50);
      return { text: "x", messages: [], toolResults: [] };
    };
    const { app } = newApp(slowFactory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    const s = await openStream(app, c.id); // 开流让 5 个 turn 正常完成（delta 有订阅者）
    await delay(15);
    for (let i = 0; i < 5; i++) {
      await postMsg(app, c.id, `m${i}`);
      await delay(5); // 远小于 50ms，确保 5 条都占住 slot
    }
    const r6 = await postMsg(app, c.id, "m5");
    expect(r6.status).toBe(429);
    await delayUntil(() => s.frames.filter((f) => f.type === "done").length >= 5, 5000); // 5 个慢 turn 串行跑完
    await s.reader.cancel();
  });
});
