// 引擎 5 判据（搬 spike-b test.mjs）。:memory: sqlite；杀进程跨实例用「同 db 文件、两个 Store」。
import { describe, test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { synthetic } from "../src/workflows/synthetic";
import { run, resume, type RunCtx } from "../src/workflow-engine/runner";
import { defineWorkflow } from "../src/workflow-engine/defineWorkflow";

const KILL_DB = "/tmp/agentany-engine-test.sqlite";

function newStore(): WorkflowStore {
  return new WorkflowStore(openDbMigrated(":memory:"));
}
function ctx(): RunCtx {
  return {
    runPi: async () => ({ text: "[stub]", messages: [], toolResults: [] }),
    projectId: "test",
    cwd: "/tmp/agentany-test-workspace",
    signal: new AbortController().signal,
    log: () => {},
  };
}
function newRunId(): string {
  return "r_" + Math.random().toString(36).slice(2, 10);
}
async function start(store: WorkflowStore, input: unknown) {
  const runId = newRunId();
  store.createRun({ runId, workflowId: synthetic.id, projectId: "test", input });
  const res = await run(synthetic, store, runId, ctx());
  return { runId, res };
}

describe("engine · 接受路径", () => {
  test("s1→review→s2，completed；review 两相(2 条)", async () => {
    const store = newStore();
    const { runId, res } = await start(store, { offset: 0 });
    expect(res.status).toBe("suspended");
    expect((res as any).stepId).toBe("review");

    const r = await resume(synthetic, store, runId, { decision: "accept" }, ctx());
    expect(r.status).toBe("completed");

    const log = store.getLog(runId);
    const completed = log.filter((e) => e.status === "completed").map((e) => e.stepId);
    expect(completed.join(",")).toBe("s1,review,s2");
    const review = log.filter((e) => e.stepId === "review").map((e) => e.status);
    expect(review.join(",")).toBe("suspended,completed");
  });
});

describe("engine · 循环路径", () => {
  test("redirect 回 s1（offset+1），再 accept", async () => {
    const store = newStore();
    const { runId, res } = await start(store, { offset: 0 });
    expect(res.status).toBe("suspended");

    const r1 = await resume(synthetic, store, runId, { decision: "redirect", focus: "brand" }, ctx());
    expect(r1.status).toBe("suspended"); // 循环回 s1 后又挂起在 review

    const r2 = await resume(synthetic, store, runId, { decision: "accept" }, ctx());
    expect(r2.status).toBe("completed");

    const s1s = store.getLog(runId).filter((e) => e.stepId === "s1");
    expect(s1s.length).toBe(2);
    const offs = s1s.map((e) => (e.output as any)?.offset);
    expect(offs[0]).toBe(0);
    expect(offs[1]).toBe(1);
  });
});

describe("engine · 杀进程跨实例 resume", () => {
  test("Store A 挂起 → 新 Store B（同 db 文件）resume → completed", async () => {
    rmSync(KILL_DB, { force: true });
    const storeA = new WorkflowStore(openDbMigrated(KILL_DB));
    const runId = newRunId();
    storeA.createRun({ runId, workflowId: synthetic.id, projectId: "test", input: { offset: 5 } });
    const a = await run(synthetic, storeA, runId, ctx());
    expect(a.status).toBe("suspended");

    // 模拟进程重启：新 Store 实例打开同一个 db 文件，状态纯由日志派生。
    const storeB = new WorkflowStore(openDbMigrated(KILL_DB));
    const b = await resume(synthetic, storeB, runId, { decision: "accept" }, ctx());
    expect(b.status).toBe("completed");
    rmSync(KILL_DB, { force: true });
  });
});

describe("engine · resumeData 校验", () => {
  test("非法 enum 被拒、状态不变；随后合法 resume 推进", async () => {
    const store = newStore();
    const { runId } = await start(store, { offset: 0 });

    const bad = await resume(synthetic, store, runId, { decision: "bogus" }, ctx());
    expect((bad as any).rejected).toBe(true);
    expect(bad.status).toBe("suspended");
    expect(store.getRun(runId)?.status).toBe("suspended");

    const good = await resume(synthetic, store, runId, { decision: "accept" }, ctx());
    expect(good.status).toBe("completed");
  });
});

describe("engine · 幂等 resume", () => {
  test("重复 resume 不产生重复推进", async () => {
    const store = newStore();
    const { runId } = await start(store, { offset: 0 });

    const r1 = await resume(synthetic, store, runId, { decision: "accept" }, ctx());
    expect(r1.status).toBe("completed");
    const len1 = store.getLog(runId).length;

    const r2 = await resume(synthetic, store, runId, { decision: "accept" }, ctx());
    expect((r2 as any).idempotent).toBe(true);
    expect(store.getLog(runId).length).toBe(len1);
  });
});

// step 抛错失败语义（修 runner 卡死 bug）：抛错 → 记 failed 日志 + status=failed，不再卡 running。
const throwing = defineWorkflow({ id: "throwing-test" })
  .step("boom", { async execute() { throw new Error("pi exploded"); } })
  .commit();

describe("engine · step 抛错 → failed（不卡 running）", () => {
  test("step.execute 抛错 → run 返 failed、status=failed、有 failed 日志", async () => {
    const store = newStore();
    const runId = newRunId();
    store.createRun({ runId, workflowId: throwing.id, projectId: "test", input: {} });
    const res = await run(throwing, store, runId, ctx());
    expect(res.status).toBe("failed");
    expect((res as any).note).toContain("pi exploded");
    expect(store.getRun(runId)?.status).toBe("failed"); // 关键：不卡 running
    const failed = store.getLog(runId).filter((e) => e.status === "failed");
    expect(failed.length).toBe(1);
    expect(failed[0].stepId).toBe("boom");
    expect((failed[0].output as any)?.error).toContain("pi exploded");
  });

  test("resume 一个 failed run → 报 failed、不再推进（可审计，不卡死）", async () => {
    const store = newStore();
    const runId = newRunId();
    store.createRun({ runId, workflowId: throwing.id, projectId: "test", input: {} });
    await run(throwing, store, runId, ctx());
    const before = store.getLog(runId).length;
    const r = await resume(throwing, store, runId, {} as any, ctx());
    expect(r.status).toBe("failed"); // 报 failed（不再卡 running）
    expect(store.getLog(runId).length).toBe(before); // 不再推进
  });
});
