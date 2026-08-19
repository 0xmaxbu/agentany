// ticket #19 Part C：真 pi 冒烟（gated on GO_API_KEY/PI_API_KEY）—— 全链。
// boot 真 server（真 makeRunPiStream + runRegistry + bridge），驱动 chat「跑合成三步」全链：
// start_workflow → run_started/step_* → run_suspended → 自动 turn → ask_user → 用户「accept」→ 判答 resume → run_completed。
// 断【结构帧序列】（非文本——pi 非确定性）。慢、耗 token。须 `DATA_DIR=<temp> bun test` 运行（config.DATA_DIR 模块加载时常量）。
// 注：完整确定性全链由 e2e/workflow.spec.ts（scripted stub 驱动真桥接真事件）覆盖；本测用真 pi 复核。
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { fullDeps } from "./deps";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { EventBus } from "../src/chat/eventbus";
import { RunRegistry } from "../src/runs/registry";
import { startBridge, BRIDGE_PORT } from "../src/bridge/server";

const HAS_KEY = !!(process.env.PI_API_KEY || process.env.GO_API_KEY);
const T = 240_000; // 真 pi 全链 ~4 turn，每 turn 慢
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function readUntil(baseUrl: string, cid: string, pred: (types: string[]) => boolean, frames: any[], timeoutMs: number): Promise<boolean> {
  const r = await fetch(`${baseUrl}/conversations/${cid}/stream`);
  if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const fr = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const ln of fr.split("\n")) {
          if (ln.startsWith("data:")) { try { frames.push(JSON.parse(ln.slice(5).replace(/^ /, ""))); } catch {} }
        }
      }
      if (pred(frames.map((f) => f.type))) return true;
    }
  } finally { try { reader.cancel(); } catch {} }
  return pred(frames.map((f) => f.type));
}

describe.skipIf(!HAS_KEY)("真 pi 冒烟 · 跑合成三步全链（#19）", () => {
  let baseUrl: string;
  let stopAll: () => void;

  beforeAll(() => {
    process.env.AGENTANY_NO_SANDBOX = "1"; // 沙箱在非标准 cwd 挡 pi → exit 1（ADR-0011 A1 WIP）；冒烟验 pi 通路
    const store = createStores(openDbMigrated());
    const eventBus = new EventBus();
    const runRegistry = new RunRegistry({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const app = createApp(fullDeps(store, { eventBus, runRegistry }));
    const bridgeSrv = startBridge(BRIDGE_PORT, { runRegistry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 255, fetch: (r) => app.fetch(r) });
    baseUrl = `http://127.0.0.1:${server.port}`;
    stopAll = () => { server.stop(); bridgeSrv.stop(); };
  });

  afterAll(() => { stopAll?.(); });

  test("跑合成三步 → run_started+step+run_suspended+hitl_request；accept → run_completed", async () => {
    const conv = await (await fetch(`${baseUrl}/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })).json() as { id: string };
    const cid = conv.id;
    const frames: any[] = [];

    // 阶段1：跑合成三步 → 期望 pi 调 start_workflow → run + suspend + ask_user
    const hit1 = readUntil(baseUrl, cid, (types) => types.includes("hitl_request"), frames, T);
    await delay(500);
    const r1 = await fetch(`${baseUrl}/conversations/${cid}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "跑合成三步" }) });
    expect([200, 202]).toContain(r1.status);
    const reachedAsk = await hit1;
    const types = frames.map((f) => f.type);
    const errMsg = frames.filter((f) => f.type === "error").map((f) => f.message).join("; ");
    expect(reachedAsk, `期望 hitl_request，实际帧：${types.join(",")}；error: ${errMsg}`).toBe(true);
    expect(types).toContain("run_started");
    expect(types.filter((t) => t.startsWith("step_")).length).toBeGreaterThan(0);
    expect(types).toContain("run_suspended");

    // 阶段2：accept → pi 判答 → resume → run_completed（重开流读，先订阅再投递）
    const hit2 = readUntil(baseUrl, cid, (types2) => types2.includes("run_completed"), frames, T);
    await delay(500);
    await fetch(`${baseUrl}/conversations/${cid}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "accept" }) });
    const reachedDone = await hit2;
    expect(reachedDone, `期望 run_completed，实际帧：${frames.map((f) => f.type).join(",")}`).toBe(true);
  }, T);
});
