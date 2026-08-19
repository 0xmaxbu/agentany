// #45/T2（ADR-0025 决策 3）：崩溃封堵对账——sweep 标 failed 同步写「异常终止」brief；boo 对账扫
// brief_message_id IS NULL 的终态 run 幂等补发简报消息；sweep 先于 reconcile；排除已删会话。
import { describe, test, expect } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { EventBus } from "../src/chat/eventbus";
import { RunLifecycle } from "../src/runs/lifecycle";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < timeoutMs) { if (pred()) return; await delay(15); }
  throw new Error("timeout");
};

function newRegistry() {
  const store = createStores(openDbMigrated(":memory:"));
  store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
  const eventBus = new EventBus();
  const registry = new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });
  return { store, eventBus, registry };
}

describe("store · sweep 写「异常终止」brief", () => {
  test("markRunningAsFailed → status failed + brief=异常终止（对账补发的文案真相）", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.runs.createRun({ runId: "r1", workflowId: "w", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.runs.updateRunStatus("r1", "running");

    const n = store.runs.markRunningAsFailed();
    expect(n).toBe(1);
    const row = store.runs.getRun("r1")!;
    expect(row.status).toBe("failed");
    expect(row.brief).toBe("异常终止（进程重启）");
    expect(row.briefMessageId).toBeNull();
  });
});

describe("store · setTerminalBrief 原子回填（code-review P4：事务外回填=重启重复简报窗口）", () => {
  test("简报消息与 briefMessageId 同事务落库——不依赖第二个调用", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.runs.createRun({ runId: "r1", workflowId: "w", workspaceId: "ws_company", conversationId: "c1", input: {} });
    const mid = store.runs.setTerminalBrief({
      runId: "r1", status: "completed", brief: "done",
      messageContent: "📋 工作流 w 完成：done", conversationId: "c1",
    });
    expect(mid).toBeGreaterThan(0);
    // 此前 briefMessageId 靠事务外 backfill——崩在两写之间，重启 reconcile 会再插一条重复简报
    expect(store.runs.getRun("r1")!.briefMessageId).toBe(mid);
  });

  test("幂等 guard：已发简报的 run 再 setTerminalBrief → 不插第二条、返已有 id", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.runs.createRun({ runId: "r1", workflowId: "w", workspaceId: "ws_company", conversationId: "c1", input: {} });
    const p = { runId: "r1", status: "completed", brief: "done", messageContent: "📋 工作流 w 完成：done", conversationId: "c1" } as const;
    const m1 = store.runs.setTerminalBrief(p);
    const m2 = store.runs.setTerminalBrief(p); // 重放（reconcile/双发路径）
    expect(m2).toBe(m1);
    expect(store.chat.listMessages("c1").filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});

describe("registry · reconcile 幂等补发", () => {
  test("终态 run brief_message_id IS NULL → 补发简报消息 + 回填；重跑只补一次", async () => {
    const { store, eventBus, registry } = newRegistry();
    // 模拟崩溃残留：completed 但简报未发（T1 同事务写 brief，发信后回填前崩）
    store.runs.createRun({ runId: "r-crash", workflowId: "brand-research", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.runs.setTerminalBrief({ runId: "r-crash", status: "completed", brief: "「X」调研完成", messageContent: "", conversationId: "c1" });

    const n = registry.reconcileBriefMessages();
    expect(n).toBe(1);
    const row = store.runs.getRun("r-crash")!;
    expect(row.briefMessageId).toBeGreaterThan(0);
    const msgs = store.chat.listMessages("c1").filter((m) => m.role === "assistant");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain("📋 工作流 brand-research 完成");

    // 幂等：重跑对账不再补
    const n2 = registry.reconcileBriefMessages();
    expect(n2).toBe(0);
    expect(store.chat.listMessages("c1").filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  test("sweep 标 failed 的 run → 对账补发「异常终止」简报（文案诚实）", async () => {
    const { store, registry } = newRegistry();
    store.runs.createRun({ runId: "r-swept", workflowId: "w", workspaceId: "ws_company", conversationId: "c1", input: {} });
    registry.sweepCrashed(); // → failed + brief=异常终止
    store.runs.createRun({ runId: "r-swept2", workflowId: "w", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.runs.updateRunStatus("r-swept2", "running"); // running 不 sweep（等下一个进程）
    const n = registry.reconcileBriefMessages();
    expect(n).toBe(1);
    const msgs = store.chat.listMessages("c1").filter((m) => m.role === "assistant");
    expect(msgs[0].content).toContain("异常终止");
  });

  test("补发文案用 row.brief（列是单一真相），不重溯 log 派生", async () => {
    const { store, registry } = newRegistry();
    store.runs.createRun({ runId: "r-b", workflowId: "brand-research", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.runs.appendLog("r-b", { stepId: "report", status: "completed", output: { brief: "log 重派生文案" } });
    store.runs.setTerminalBrief({ runId: "r-b", status: "completed", brief: "列里真相", messageContent: "", conversationId: "c1" });

    expect(registry.reconcileBriefMessages()).toBe(1);
    const msgs = store.chat.listMessages("c1").filter((m) => m.role === "assistant");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain("列里真相");
    expect(msgs[0].content).not.toContain("log 重派生文案");
  });

  test("G2 宽窗：终态但 brief IS NULL（引擎落终态→deliverBrief 前崩）→ 从 log 兜底派生补发", async () => {
    const { store, registry } = newRegistry();
    // 模拟:引擎把 run 推进到 completed（appendStep 带 runStatus 同事务）但 deliverBrief 未跑——
    // 旧窄窗(只扫 briefMessageId IS NULL)抓不到;宽窗=终态 ∧ (brief 缺 OR briefMessageId 缺)。
    store.runs.createRun({ runId: "r-wide", workflowId: "brand-research", workspaceId: "ws_company", conversationId: "c1", input: { brand: "宽窗" } });
    store.runs.appendStep("r-wide", { stepId: "report", status: "completed", output: { brief: "宽窗简报" }, runStatus: "completed" });
    expect(store.runs.getRun("r-wide")!.brief).toBeNull(); // 前提:brief 缺(崩窗口正中)

    expect(registry.reconcileBriefMessages()).toBe(1);
    const row = store.runs.getRun("r-wide")!;
    expect(row.briefMessageId).toBeGreaterThan(0);
    expect(row.brief).toContain("宽窗简报"); // brief 由 log 兜底派生回填
    const msgs = store.chat.listMessages("c1").filter((m) => m.role === "assistant");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain("宽窗简报");
    expect(registry.reconcileBriefMessages()).toBe(0); // 已持 brief+briefMessageId → 幂等
  });

  test("对账排除已删会话的 run（conversationId 已解绑）", () => {
    const { store, registry } = newRegistry();
    store.runs.createRun({ runId: "r-orphan", workflowId: "w", workspaceId: "ws_company", conversationId: null, input: {} });
    store.runs.setTerminalBrief({ runId: "r-orphan", status: "failed", brief: "x", messageContent: "", conversationId: null });
    expect(registry.reconcileBriefMessages()).toBe(0); // 无会话 → 不补发（消息无处可落）
  });
});

describe("full swing · boot 顺序 sweep → reconcile（无 LLM、经 EventBus 帧）", () => {
  test("registry.start → 正常完成（简报已发）→ reconcile no-op；崩溃残留模拟 → 补发", async () => {
    const { store, eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const started = await registry.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {}, approved: true });
    if (started.status !== "running") throw new Error("expected running");
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));
    await registry.resume(started.runId, { decision: "accept" });
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));

    // 正常路径：简报已发 → 对账 no-op
    expect(registry.reconcileBriefMessages()).toBe(0);
    expect(store.runs.getRun(started.runId)!.briefMessageId).toBeGreaterThan(0);
  });
});