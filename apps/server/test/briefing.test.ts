// #41/T1（ADR-0025 决策 1/2/4）：run 终态零 LLM 简报——completed 取末步 output.brief / failed 取 note，
// 同事务写 brief 列 + 落 assistant 简报消息 + touch 会话；read_run 8000 封顶。
// seam：真 Hono app（DI stub runPi）+ :memory: db + 真 EventBus；registry.start 直接驱动（T6 才走 POST 消息链）。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { RunRegistry } from "../src/runs/registry";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";
import { READ_FOOTER, READ_TRUNCATE } from "../src/runs/briefing";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await delay(15);
  }
  throw new Error("timeout waiting for condition");
};

// 收敛 StartOutcome → 必 running 的 runId（synthetic/brand-research 在 auto 姿态下直跑）。
const startedRunning = (s: ReturnType<RunRegistry["start"]>) => {
  if (s.status !== "running") throw new Error(`expected running, got ${s.status}`);
  return s.runId;
};

// 正常 stub：research 步调 runPi → 立即返空文本（brand-research 读 angles.json 失败 → 空数组）。
const okStub = (): ConfiguredRunPi => async () => ({ text: "stub 完成", messages: [], toolResults: [] });
// 失败 stub：research 步调 runPi → 抛错（note="boom"）。
const failStub = (): ConfiguredRunPi => async () => {
  throw new Error("boom");
};

function setup(stubFactory: () => ConfiguredRunPi = okStub) {
  const db = openDbMigrated(":memory:");
  const store = new WorkflowStore(db);
  const eventBus = new EventBus();
  const runRegistry = new RunRegistry({ store, eventBus, runPiFactory: stubFactory });
  const deps: RunDeps = {
    store, userStore: new UserStore(db), streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db), eventBus, runRegistry,
  };
  store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "dev-user" });
  const app = createApp(deps);
  return { deps, store, eventBus, app, runRegistry };
}

describe("T1 简报直投 · completed", () => {
  test("brand-research 完成 → 同事务写 brief+briefMessageId + 简报消息 + 会话 touch + 帧", async () => {
    const { store, eventBus, runRegistry } = setup(okStub);
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const touchedBefore = store.getConversation("c1")!.updatedAt;

    const started = runRegistry.start({ conversationId: "c1", workflowId: "brand-research", input: { brand: "测试" }, approved: true });
    const runId = startedRunning(started);
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));

    // DB 终态：brief + briefMessageId 与终态同现
    const row = store.getRun(runId)!;
    expect(row.status).toBe("completed");
    expect(row.brief).toContain("调研完成");
    expect(row.briefMessageId).toBeGreaterThan(0);
    expect(store.getRun(runId)!.briefMessageId).toBe(row.briefMessageId);

    // 简报消息落库（role=assistant、前缀自标识、artifacts linkify 白名单精确匹配）
    const msgs = store.listMessages("c1");
    expect(msgs.filter((m) => m.role === "assistant").length).toBe(1);
    const last = msgs[msgs.length - 1];
    expect(last.content.startsWith("📋 工作流 brand-research 完成：")).toBeTrue();
    expect(last.content).toContain("](/files/ws_company/brand-research/");
    expect(last.content).toContain("research-report.md](");

    // 会话浮起（touchConversation 同事务）
    expect(store.getConversation("c1")!.updatedAt > touchedBefore).toBeTrue();

    // 帧：run_completed 带 brief/artifacts + 简报 text 块（start/delta/end，无 done 帧）
    const done = frames.find((f) => f.type === "run_completed");
    expect(done.brief).toContain("调研完成");
    expect(done.artifacts).toContain("brand-research/测试-全国/angles.json");
    const starts = frames.filter((f) => f.type === "block_start");
    expect(starts.some((f) => f.kind === "text")).toBeTrue();
    expect(frames.some((f) => f.type === "block_end")).toBeTrue();
    expect(frames.some((f) => f.type === "done")).toBeFalse();
  });

  test("缺 brief → 步骤列表兜底（不崩、不静默）", async () => {
    const { store, eventBus, runRegistry } = setup(okStub);
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));

    const r = runRegistry.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {} });
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));
    await runRegistry.resume((r as { runId: string }).runId, { decision: "accept" });
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));

    const row = store.getRun((r as { runId: string }).runId)!;
    expect(row.status).toBe("completed");
    expect(row.brief).toContain("已完成步骤");
    expect(row.brief).toContain("s1");
    const msgs = store.listMessages("c1");
    expect(msgs[msgs.length - 1].content.startsWith("📋 工作流 synthetic-3step 完成：")).toBeTrue();
  });
});

describe("T1 简报直投 · failed", () => {
  test("runPi 抛错 → note 即简报（截首行/200）+ run_failed 帧 + 简报消息", async () => {
    const { store, eventBus, runRegistry } = setup(failStub);
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));

    const r = runRegistry.start({ conversationId: "c1", workflowId: "brand-research", input: { brand: "失败车" }, approved: true });
    await delayUntil(() => frames.some((f) => f.type === "run_failed"));

    const row = store.getRun((r as { runId: string }).runId)!;
    expect(row.status).toBe("failed");
    expect(row.brief).toBe("boom");
    const msgs = store.listMessages("c1");
    expect(msgs[msgs.length - 1].content).toBe("📋 工作流 brand-research 失败：boom");
    expect(frames.some((f) => f.type === "block_start")).toBeTrue();
  });
});

describe("T1 read_run 8k 封顶", () => {
  test("latestOutput stringify 截 8000 + 尾注；短输出原样", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    const registry = new RunRegistry({ store, eventBus: new EventBus(), runPiFactory: okStub });

    store.createRun({ runId: "r-short", workflowId: "w", workspaceId: "ws_company", input: {}, conversationId: null });
    store.appendLog("r-short", { stepId: "s", status: "completed", output: { text: "短" } });
    const short = registry.read("r-short")!;
    expect(short.latestOutput).toEqual({ text: "短" }); // 短原样（对象不串化）

    store.createRun({ runId: "r-long", workflowId: "w", workspaceId: "ws_company", input: {}, conversationId: null });
    store.appendLog("r-long", { stepId: "s", status: "completed", output: { text: "x".repeat(10000) } });
    const long = registry.read("r-long")!;
    expect(typeof long.latestOutput).toBe("string");
    expect((long.latestOutput as string).length).toBe(READ_TRUNCATE + READ_FOOTER.length);
    expect((long.latestOutput as string)).toContain("已截断");
    expect((long.latestOutput as string)).toContain("全文见 DB/文件");
  });
});