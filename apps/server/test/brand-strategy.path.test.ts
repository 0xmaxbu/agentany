// brand-strategy-analysis 路径卫生（修 anglesPath 任意文件读 + reportPath 未 slugify）。
// select-angles 纯读、不调 runPi；generate-report 用 stub runPi 捕获 prompt 验 reportPath。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { run, resume, type RunCtx } from "../src/workflow-engine/runner";
import { brandStrategyAnalysis } from "../src/workflows/brand-strategy-analysis";

const CWD = `/tmp/agentany-bsa-test-${process.pid}`;
const newStore = () => createStores(openDbMigrated(":memory:"));
const newRunId = () => "r_" + Math.random().toString(36).slice(2, 10);

beforeEach(() => { rmSync(CWD, { recursive: true, force: true }); mkdirSync(CWD, { recursive: true }); });
afterEach(() => { rmSync(CWD, { recursive: true, force: true }); });

function ctx(capture?: { p: string }): RunCtx {
  return {
    runPi: async (opts: { prompt: string }) => { if (capture) capture.p = opts.prompt; return { text: "[stub]", messages: [], toolResults: [] }; },
    workspaceId: "ws_test", cwd: CWD, signal: new AbortController().signal, log: () => {},
  };
}
async function startWith(store: Stores, input: unknown) {
  const runId = newRunId();
  store.runs.createRun({ runId, workflowId: brandStrategyAnalysis.id, workspaceId: "ws_test", input });
  return { runId, res: await run(brandStrategyAnalysis, store.runs, runId, ctx()) };
}

describe("brand-strategy-analysis · anglesPath 路径卫生", () => {
  test("默认从工作区读 angles.json → suspend（ask 契约 context 预渲染）", async () => {
    const store = newStore();
    const dir = join(CWD, "brand-research", "acme-全国");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "angles.json"), JSON.stringify([{ id: 1, title: "t" }]));
    const started = await startWith(store, { brand: "acme" });
    expect(started.res.status).toBe("suspended");
    const sus = store.runs.getLog(started.runId).at(-1);
    expect((sus as any).suspendPayload?.question).toContain("请选择要深化的切入角度");
    expect((sus as any).suspendPayload?.context).toContain("1. t"); // angles 预渲染进 context
    expect((sus as any).resumeSchema).toBeTruthy(); // ADR-0031：resumeSchema 与 payload 同落 log
  });

  test("anglesPath 指向工作区【外】的有效 JSON → failed（防跨区/任意文件读）", async () => {
    const outside = `/tmp/agentany-outside-${process.pid}-${Math.random().toString(36).slice(2, 6)}.json`;
    writeFileSync(outside, JSON.stringify([{ id: "SECRET" }])); // 工作区外、有效 JSON
    try {
      const store = newStore();
      const { res } = await startWith(store, { brand: "acme", anglesPath: outside });
      expect(res.status).toBe("failed"); // 关键：不把 outside 的 SECRET 读进 payload
    } finally { rmSync(outside, { force: true }); }
  });

  test("anglesPath 相对越界（../）→ failed", async () => {
    const store = newStore();
    const { res } = await startWith(store, { brand: "acme", anglesPath: "../../../etc/hostname" });
    expect(res.status).toBe("failed");
  });

  test("anglesPath 指向工作区内有效 JSON → 正常读（灵活性保留）", async () => {
    const store = newStore();
    writeFileSync(join(CWD, "custom-angles.json"), JSON.stringify([{ id: 9 }]));
    const s2 = await startWith(store, { brand: "acme", anglesPath: "custom-angles.json" });
    expect(s2.res.status).toBe("suspended");
    const sus2 = store.runs.getLog(s2.runId).at(-1);
    expect((sus2 as any).suspendPayload?.context).toContain("1. 9"); // 由 {id:9}（无 title → id）预渲染
  });
});

describe("brand-strategy-analysis · reportPath slugify", () => {
  test("brand 含 ../ → reportPath 落 reports/ 下、不逃目录（slugify）", async () => {
    const store = newStore();
    const { runId, res } = await startWith(store, { brand: "../evil", region: "x" });
    expect(res.status).toBe("suspended");

    const cap = { p: "" };
    const r = await resume(brandStrategyAnalysis, store.runs, runId, { selected: "all" }, ctx(cap));
    expect(r.status).toBe("suspended"); // approve-report 挂起
    // 从 generate-report 的 prompt 抽 reportPath：修复前 join("../evil-…") 会逃到 CWD 根（不在 reports/）。
    const m = cap.p.match(/写报告 → (.+?)（执行摘要/);
    expect(m).toBeTruthy();
    const reportPath = m![1].trim();
    expect(reportPath.startsWith(join(CWD, "reports"))).toBe(true);
  });
});
