// ADR-0030（#67/A1）验收：createStores 单点装配（四 store 共享同一 db + 单调时钟）
// + context 一等列（createQuestion/suspendWithAskCard 直列写读、registry 零走私）
// + RunsStore 原子事务面落位（appendStep/suspendedStep：G1/G2 surface，A2 接入 runner/registry）。
import { describe, test, expect } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { createStores } from "../src/stores";
import { RunRegistry } from "../src/runs/registry";
import { EventBus } from "../src/chat/eventbus";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(10); }
};

describe("createStores（决策 5）：四 store 共享同一 db", () => {
  test("chat 会话 / runs run / hitl 卡 / feedback 行互见（跨域写进同库）", () => {
    const { runs, chat, hitl, feedback } = createStores(openDbMigrated(":memory:"));
    chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u1" });
    runs.createRun({ runId: "r1", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} });
    const qid = hitl.createQuestion({ conversationId: "c1", prompt: "q", options: ["A"] });
    feedback.addFeedback({ targetKind: "message", targetId: "1", text: "ok" });
    expect(chat.getConversation("c1")!.userId).toBe("u1");
    expect(runs.getRun("r1")!.conversationId).toBe("c1");
    expect(hitl.getQuestion(qid)!.conversationId).toBe("c1");
    expect(feedback.listFeedbackSince(0)).toHaveLength(1);
  });

  test("单调时钟（db-utils now 共享）：同 ms 连续操作不退化排序锚", () => {
    const { chat } = createStores(openDbMigrated(":memory:"));
    for (const id of ["a", "b", "c"]) chat.createConversation({ id, workspaceId: "ws_company", userId: "u" });
    chat.touchConversation("b"); // 同 tick 触达 b → 必须排最前（若时钟退化会按插入序 a 在前）
    expect(chat.listConversations("u").map((c) => c.id)).toEqual(["b", "c", "a"]);
  });
});

describe("context 一等列（决策 3：退役 input-as-{context} 走私）", () => {
  test("createQuestion 写 context → getQuestion/listQuestions 直读列", () => {
    const { chat, hitl } = createStores(openDbMigrated(":memory:"));
    chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    const qid = hitl.createQuestion({ conversationId: "c1", prompt: "q", options: ["A"], context: "## 摘要\n要点" });
    expect(hitl.getQuestion(qid)!.context).toBe("## 摘要\n要点");
    expect(hitl.listQuestions("c1")[0].context).toBe("## 摘要\n要点");
    expect(hitl.getQuestion(qid)!.input).toBeNull(); // 不再走私进 input 列
  });

  test("suspendWithAskCard 写 context 直列 + registry 零 {context} 包装知识（全链透出）", async () => {
    const store = createStores(openDbMigrated(":memory:"));
    const reg = new RunRegistry({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus: new EventBus(), runPiFactory: stubFactory });
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    const start = reg.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {} });
    expect(start.status).toBe("running");
    const runId = (start as any).runId as string;
    await delayUntil(() => !!store.hitl.getPendingByRun(runId)); // 挂起 + 引擎直建卡
    const q = store.hitl.getPendingByRun(runId)!;
    expect(q.kind).toBe("ask");
    expect(q.context).toMatch(/^当前产出：/); // payload context → 一等列（synthetic review ask 产 context）
    expect((q.input as any)?.context).toBeUndefined(); // 走私包装已退役
    expect(q.values).toBeTruthy(); // 快照仍在
  });
});

describe("RunsStore 原子事务面（G1/G2，ADR-0031 surface、A1 落位、A2 接入）", () => {
  test("appendStep：log 行 + run status 同事务；runStatus 缺失 → 只落 log", () => {
    const { runs } = createStores(openDbMigrated(":memory:"));
    runs.createRun({ runId: "r1", workflowId: "wf", workspaceId: "ws_company", input: {} });
    runs.appendStep("r1", { stepId: "s1", status: "completed", runStatus: "completed" });
    expect(runs.getRun("r1")!.status).toBe("completed"); // 终态与 log 原子同现
    const log = runs.getLog("r1");
    expect(log).toHaveLength(1);
    expect(log[0].stepId).toBe("s1");
    expect(log[0].status).toBe("completed");
    runs.appendStep("r1", { stepId: "s2", status: "completed" }); // 中间步不带 runStatus → 不动 status
    expect(runs.getRun("r1")!.status).toBe("completed");
    expect(runs.getLog("r1")).toHaveLength(2);
  });

  test("suspendedStep：log(suspended)+run status+ask 卡同一事务（孤儿窗口归零）", () => {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.runs.createRun({ runId: "r1", workflowId: "wf", workspaceId: "ws_company", conversationId: "c1", input: {} });
    const qid = store.runs.suspendedStep({
      runId: "r1", stepId: "review", input: {},
      suspendPayload: { question: "选？", options: [], context: "决策素材" },
      resumeSchema: { _t: "enum", vals: ["a"] }, conversationId: "c1", values: [{ label: "A", value: "a" }],
    });
    expect(qid).toBeGreaterThan(0);
    expect(store.runs.getRun("r1")!.status).toBe("suspended");
    const log = store.runs.getLog("r1");
    expect(log[log.length - 1].status).toBe("suspended");
    const q = store.hitl.getQuestion(qid)!;
    expect(q.kind).toBe("ask");
    expect(q.conversationId).toBe("c1");
    expect(q.values).toEqual([{ label: "A", value: "a" }]); // 快照同事务落显
  });
});