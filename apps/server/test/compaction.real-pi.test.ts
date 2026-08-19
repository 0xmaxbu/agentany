// ticket #19 Part D：compaction 实测（gated on GO_API_KEY/PI_API_KEY）。
// 真 pi 长对话（N 轮，COMPACTION_TURNS 可配）→ session jsonl 落 transcript（session/message 行）。
// compaction 检查点：pi 在 token 阈值压缩上下文，jsonl 出现非 message 的检查点行（实测发现 marker）。
// 本测：断【长对话 transcript 持久化到 jsonl】（确定可验）+ 报告 compaction 标记数（best-effort，需足够 token 才触发）。
// 慢、耗 token。**须以 `DATA_DIR=<temp> bun test` 运行**（config.DATA_DIR 是模块加载时常量，beforeAll 设太晚）。
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../src/app";
import { fullDeps } from "./deps";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { EventBus } from "../src/chat/eventbus";
import { RunRegistry } from "../src/runs/registry";
import { startBridge, BRIDGE_PORT } from "../src/bridge/server";
import { DATA_DIR } from "../src/config";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HAS_KEY = !!(process.env.PI_API_KEY || process.env.GO_API_KEY);
const N = Number(process.env.COMPACTION_TURNS ?? 12); // 轮数（compaction 阈值高，可调大）
const PER_TURN = 60_000;
const T = N * PER_TURN + 30_000;

async function sendAndWait(baseUrl: string, cid: string, content: string, timeoutMs: number): Promise<void> {
  await fetch(`${baseUrl}/conversations/${cid}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
  const sr = await fetch(`${baseUrl}/conversations/${cid}/stream`);
  const rd = sr.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  const dl = Date.now() + timeoutMs;
  try {
    outer: while (Date.now() < dl) {
      const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value);
      let j;
      while ((j = buf.indexOf("\n\n")) >= 0) {
        const fr = buf.slice(0, j); buf = buf.slice(j + 2);
        for (const ln of fr.split("\n")) {
          if (ln.startsWith("data:")) { try { if (JSON.parse(ln.slice(5).replace(/^ /, "")).type === "done") break outer; } catch {} }
        }
      }
    }
  } finally { try { rd.cancel(); } catch {} }
}

describe.skipIf(!HAS_KEY)("compaction 实测 · 真 pi 长对话 jsonl（#19）", () => {
  let baseUrl: string;
  let stopAll: () => void;

  beforeAll(() => {
    process.env.AGENTANY_NO_SANDBOX = "1"; // 沙箱在非标准 cwd 挡 pi（spawn 时读，beforeAll 设有效）
    // DATA_DIR 须外部以 `DATA_DIR=<temp> bun test` 设（模块加载时常量）；DATA_DIR 即其解析值。
    const store = createStores(openDbMigrated());
    const eventBus = new EventBus();
    const runRegistry = new RunRegistry({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const app = createApp(fullDeps(store, { eventBus, runRegistry }));
    const bridgeSrv = startBridge(BRIDGE_PORT, { runRegistry, runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 255, fetch: (r) => app.fetch(r) });
    baseUrl = `http://127.0.0.1:${server.port}`;
    stopAll = () => { server.stop(); bridgeSrv.stop(); };
  });

  afterAll(() => {
    stopAll?.();
    // 仅清 tmp 下的 DATA_DIR（防误删真实 data/）
    if (DATA_DIR.startsWith(tmpdir())) try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  });

  test(`${N} 轮长对话 → session jsonl 落 transcript + compaction 标记报告`, async () => {
    const conv = await (await fetch(`${baseUrl}/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })).json() as { id: string };
    const cid = conv.id;
    // 长消息催 compaction（每轮请 pi 写长段）
    for (let i = 0; i < N; i++) {
      await sendAndWait(baseUrl, cid, `第${i + 1}轮：请详细写一段约 300 字的短文，主题「数字${i + 1}的遐想」。`, PER_TURN);
    }

    // 找 session jsonl（generalSessionDir 受 DATA_DIR 影响——但 config.DATA_DIR 是模块加载时常量；
    // 此处 dataDir 已在 import 前设进 process.env，generalSessionDir 读 process.env.DATA_DIR 吗？否——DATA_DIR 是 const。
    // 改用直接拼路径。）
    const sessDir = join(DATA_DIR, "general", "pi-sessions");
    // #命名 后每会话有两个 session 文件：chat-<cid>（本测 transcript）+ title-<cid>（一次性命名，
    // 仅 2 行 message）——按会话 id 精确锁定 chat- 文件，不再字典序取尾（会捡到 title-）。
    const files = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl") && f.includes(`chat-${cid}`));
    expect(files.length, `期望本会话 session jsonl 落盘，实际 files: ${files.join(",")}`).toBeGreaterThan(0);
    const jl = readFileSync(join(sessDir, files[files.length - 1]), "utf8");
    const lines = jl.split("\n").filter(Boolean);
    const BASE_TYPES = new Set(["session", "model_change", "thinking_level_change", "message"]);
    const lineTypes = lines.map((l) => { try { const o = JSON.parse(l); return String(o.type ?? o.role ?? "?"); } catch { return "?"; } });
    const types: Record<string, number> = {};
    for (const t of lineTypes) types[t] = (types[t] ?? 0) + 1;
    // 结构化 compaction 检测：检查点行 = 类型不在基础 4 种里（session/model_change/thinking_level_change/message）。
    // （不 grep message 文本——曾误匹配 pi 回答里的"summary"等词。pi 在逼近上下文上限时插检查点行。）
    const checkpointLines = lineTypes.filter((t) => t !== "?" && !BASE_TYPES.has(t)).length;
    console.log(`[compaction] ${N} 轮 → jsonl ${lines.length} 行；types=${JSON.stringify(types)}；检查点行(非基础类型)=${checkpointLines}`);

    // 确定可验：transcript 持久化（session + 多条 message）
    expect(types.session).toBeGreaterThanOrEqual(1);
    expect((types.message ?? 0)).toBeGreaterThanOrEqual(N); // 至少 N 条用户 message 落盘
    // compaction 检查点：pi 逼近【上下文上限】才插检查点行（spike-a:73「逼近上限时调 compact」）。
    // 实测 N=12/20（~20k token）均未触发（types 仅基础 4 种）——brute-force 到上下文上限需巨量 token（spike 因此未测），
    // 不宜作 CI 绿测。此处结构化检测：若 pi 触发则 checkpointLines>0（报 PASS），否则报 N 不足（不 fail）。
    if (checkpointLines > 0) console.log(`[compaction] ✓ 触发（${checkpointLines} 检查点行）`);
    else console.log(`[compaction] 未触发（N=${N} 不足；pi 阈值=上下文上限，需巨量 token——手动超长会话复测）`);
  }, T);
});
