// #45/T2（ADR-0025 决策 3）：崩溃封堵对账——sweep 标 failed 同步写「异常终止」brief；boo 对账扫
// brief_message_id IS NULL 的终态 run 幂等补发简报消息；sweep 先于 reconcile；排除已删会话。
import { describe, test, expect } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { EventBus } from "../src/chat/eventbus";
import { RunRegistry } from "../src/runs/registry";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < timeoutMs) { if (pred()) return; await delay(15); }
  throw new Error("timeout");
};

function newRegistry() {
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
  const eventBus = new EventBus();
  const registry = new RunRegistry({ store, eventBus, runPiFactory: stubFactory });
  return { store, eventBus, registry };
}

describe("store · sweep 写「异常终止」brief", () => {
  test("markRunningAsFailed → status failed + brief=异常终止（对账补发的文案真相）", () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createRun({ runId: "r1", workflowId: "w", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.updateRunStatus("r1", "running");

    const n = store.markRunningAsFailed();
    expect(n).toBe(1);
    const row = store.getRun("r1")!;
    expect(row.status).toBe("failed");
    expect(row.brief).toBe("异常终止（进程重启）");
    expect(row.briefMessageId).toBeNull();
  });
});

describe("registry · reconcile 幂等补发", () => {
  test("终态 run brief_message_id IS NULL → 补发简报消息 + 回填；重跑只补一次", async () => {
    const { store, eventBus, registry } = newRegistry();
    // 模拟崩溃残留：completed 但简报未发（T1 同事务写 brief，发信后回填前崩）
    store.createRun({ runId: "r-crash", workflowId: "brand-research", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.setTerminalBrief({ runId: "r-crash", status: "completed", brief: "「X」调研完成", messageContent: "", conversationId: "c1" });

    const n = registry.reconcileBriefMessages();
    expect(n).toBe(1);
    const row = store.getRun("r-crash")!;
    expect(row.briefMessageId).toBeGreaterThan(0);
    const msgs = store.listMessages("c1").filter((m) => m.role === "assistant");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain("📋 工作流 brand-research 完成");

    // 幂等：重跑对账不再补
    const n2 = registry.reconcileBriefMessages();
    expect(n2).toBe(0);
    expect(store.listMessages("c1").filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  test("sweep 标 failed 的 run → 对账补发「异常终止」简报（文案诚实）", async () => {
    const { store, registry } = newRegistry();
    store.createRun({ runId: "r-swept", workflowId: "w", workspaceId: "ws_company", conversationId: "c1", input: {} });
    registry.sweepCrashed(); // → failed + brief=异常终止
    store.createRun({ runId: "r-swept2", workflowId: "w", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.updateRunStatus("r-swept2", "running"); // running 不 sweep（等下一个进程）
    const n = registry.reconcileBriefMessages();
    expect(n).toBe(1);
    const msgs = store.listMessages("c1").filter((m) => m.role === "assistant");
    expect(msgs[0].content).toContain("异常终止");
  });

  test("对账排除已删会话的 run（conversationId 已解绑）", () => {
    const { store, registry } = newRegistry();
    store.createRun({ runId: "r-orphan", workflowId: "w", workspaceId: "ws_company", conversationId: null, input: {} });
    store.setTerminalBrief({ runId: "r-orphan", status: "failed", brief: "x", messageContent: "", conversationId: null });
    expect(registry.reconcileBriefMessages()).toBe(0); // 无会话 → 不补发（消息无处可落）
  });
});

describe("full swing · boot 顺序 sweep → reconcile（无 LLM、经 EventBus 帧）", () => {
  test("registry.start → 正常完成（简报已发）→ reconcile no-op；崩溃残留模拟 → 补发", async () => {
    const { store, eventBus, registry } = newRegistry();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const started = registry.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {}, approved: true });
    if (started.status !== "running") throw new Error("expected running");
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));
    await registry.resume(started.runId, { decision: "accept" });
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));

    // 正常路径：简报已发 → 对账 no-op
    expect(registry.reconcileBriefMessages()).toBe(0);
    expect(store.getRun(started.runId)!.briefMessageId).toBeGreaterThan(0);
  });
});