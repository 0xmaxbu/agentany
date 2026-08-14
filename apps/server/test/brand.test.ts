// brand 工作流步结构测试（stub runPi）。brand-research（1 步）+ brand-strategy-analysis（3 步 + revise 循环）。
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { brandResearch } from "../src/workflows/brand-research";
import { brandStrategyAnalysis } from "../src/workflows/brand-strategy-analysis";
import { run, resume, type RunCtx } from "../src/workflow-engine/runner";

const newStore = () => new WorkflowStore(openDbMigrated(":memory:"));
const stubCtx = (cwd: string): RunCtx => ({
  runPi: async () => ({ text: "[stub-report]", messages: [], toolResults: [] }),
  workspaceId: "ws_test",
  cwd,
  signal: new AbortController().signal,
  log: () => {},
});
const newRunId = () => "r_" + Math.random().toString(36).slice(2, 10);

describe("brand-research · 全自动 1 步", () => {
  test("research → completed（stub runPi，angles 空）", async () => {
    const store = newStore();
    const cwd = mkdtempSync(join(tmpdir(), "br-"));
    const runId = newRunId();
    store.createRun({ runId, workflowId: brandResearch.id, workspaceId: "ws_test", input: { brand: "测试品牌", region: "重庆" } });
    const r = await run(brandResearch, store, runId, stubCtx(cwd));
    expect(r.status).toBe("completed");
    const log = store.getLog(runId);
    expect(log.at(-1)?.status).toBe("completed");
    expect(log.at(-1)?.stepId).toBe("research");
    const out = log.at(-1)?.output as any;
    expect(Array.isArray(out.angles)).toBe(true);
    expect(out.reportPath).toContain("research-report.md");
  });

  test("region 缺省 → 全国", async () => {
    const store = newStore();
    const cwd = mkdtempSync(join(tmpdir(), "br-"));
    const runId = newRunId();
    store.createRun({ runId, workflowId: brandResearch.id, workspaceId: "ws_test", input: { brand: "X" } });
    await run(brandResearch, store, runId, stubCtx(cwd));
    const out = store.getLog(runId).at(-1)?.output as any;
    expect(out.region).toBe("全国");
    expect(out.reportPath).toContain("X-全国");
  });
});

describe("brand-strategy-analysis · HITL 3 步 + revise 循环", () => {
  test("select→generate→approve(revise→loop)→approve → completed", async () => {
    const store = newStore();
    const cwd = mkdtempSync(join(tmpdir(), "bsa-"));
    const brand = "测试品牌";
    const region = "全国";
    // 预写 angles.json（模拟 brand-research 产出）
    const dir = join(cwd, "brand-research", `${brand}-${region}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "angles.json"),
      JSON.stringify([{ id: 1, title: "t1", insight: "i1" }, { id: 2, title: "t2", insight: "i2" }]),
    );
    const runId = newRunId();
    store.createRun({ runId, workflowId: brandStrategyAnalysis.id, workspaceId: "ws_test", input: { brand, region } });
    const ctx = stubCtx(cwd);

    // 1. start → select-angles suspend（带 angles）
    let r: any = await run(brandStrategyAnalysis, store, runId, ctx);
    expect(r.status).toBe("suspended");
    expect((r as any).stepId).toBe("select-angles");
    expect(((r as any).payload as any).angles.length).toBe(2);

    // 2. resume select → generate → approve suspend
    r = await resume(brandStrategyAnalysis, store, runId, { selected: "1" }, ctx);
    expect(r.status).toBe("suspended");
    expect((r as any).stepId).toBe("approve-report");

    // 3. resume approve revise → 循环 generate → 再 approve suspend
    r = await resume(brandStrategyAnalysis, store, runId, { decision: "revise", comments: "再深一点" }, ctx);
    expect(r.status).toBe("suspended");
    expect((r as any).stepId).toBe("approve-report");
    const gen = store.getLog(runId).filter((e) => e.stepId === "generate-report" && e.status === "completed");
    expect(gen.length).toBe(2); // 循环：2 条 generate-report

    // 4. resume approve → completed
    r = await resume(brandStrategyAnalysis, store, runId, { decision: "approve" }, ctx);
    expect(r.status).toBe("completed");
  });

  test("resumeData 校验：坏 decision 被拒", async () => {
    const store = newStore();
    const cwd = mkdtempSync(join(tmpdir(), "bsa-"));
    const dir = join(cwd, "brand-research", "B-全国");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "angles.json"), "[]");
    const runId = newRunId();
    store.createRun({ runId, workflowId: brandStrategyAnalysis.id, workspaceId: "ws_test", input: { brand: "B" } });
    const ctx = stubCtx(cwd);
    await run(brandStrategyAnalysis, store, runId, ctx); // → select suspend
    // 选完到 approve suspend
    await resume(brandStrategyAnalysis, store, runId, { selected: "all" }, ctx);
    // 坏 decision
    const bad = await resume(brandStrategyAnalysis, store, runId, { decision: "bogus" }, ctx);
    expect((bad as any).rejected).toBe(true);
  });
});
