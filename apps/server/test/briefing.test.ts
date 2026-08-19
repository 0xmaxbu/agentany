// #41/T1（ADR-0025 决策 1/2/4）：run 终态零 LLM 简报——completed 取末步 output.brief / failed 取 note，
// 同事务写 brief 列 + 落 assistant 简报消息 + touch 会话；read_run 8000 封顶。
// seam：真 Hono app（DI stub runPi）+ :memory: db + 真 EventBus；registry.start 直接驱动（T6 才走 POST 消息链）。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { RunLifecycle, type StartResult } from "../src/runs/lifecycle";
import { ConversationQueues } from "../src/chat/queue";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi, ConfiguredRunPiStream } from "../src/pi/runPi-factory";
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

// 收敛 StartResult → 必 running 的 runId（synthetic/brand-research 在 auto 姿态下直跑）。
const startedRunning = (s: StartResult) => {
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
  const store = createStores(db);
  const eventBus = new EventBus();
  const runLifecycle = new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory });
  const deps: RunDeps = {
    runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore: new UserStore(db), streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db), eventBus, runLifecycle,
  };
  store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "dev-user" });
  const app = createApp(deps);
  return { deps, store, eventBus, app, runLifecycle };
}

describe("T1 简报直投 · completed", () => {
  test("brand-research 完成 → 同事务写 brief+briefMessageId + 简报消息 + 会话 touch + 帧", async () => {
    const { store, eventBus, runLifecycle } = setup(okStub);
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const touchedBefore = store.chat.getConversation("c1")!.updatedAt;

    const started = await runLifecycle.start({ conversationId: "c1", workflowId: "brand-research", input: { brand: "测试" }, approved: true });
    const runId = startedRunning(started);
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));

    // DB 终态：brief + briefMessageId 与终态同现
    const row = store.runs.getRun(runId)!;
    expect(row.status).toBe("completed");
    expect(row.brief).toContain("调研完成");
    expect(row.briefMessageId).toBeGreaterThan(0);
    expect(store.runs.getRun(runId)!.briefMessageId).toBe(row.briefMessageId);

    // 简报消息落库（role=assistant、前缀自标识、artifacts linkify 白名单精确匹配）
    const msgs = store.chat.listMessages("c1");
    expect(msgs.filter((m) => m.role === "assistant").length).toBe(1);
    const last = msgs[msgs.length - 1];
    expect(last.content.startsWith("📋 工作流 brand-research 完成：")).toBeTrue();
    expect(last.content).toContain("](/files/ws_company/brand-research/");
    expect(last.content).toContain("research-report.md](");

    // 会话浮起（touchConversation 同事务）
    expect(store.chat.getConversation("c1")!.updatedAt > touchedBefore).toBeTrue();

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
    const { store, eventBus, runLifecycle } = setup(okStub);
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));

    const r = await runLifecycle.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {} });
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));
    await runLifecycle.resume((r as { runId: string }).runId, { decision: "accept" });
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));

    const row = store.runs.getRun((r as { runId: string }).runId)!;
    expect(row.status).toBe("completed");
    expect(row.brief).toContain("已完成步骤");
    expect(row.brief).toContain("s1");
    const msgs = store.chat.listMessages("c1");
    expect(msgs[msgs.length - 1].content.startsWith("📋 工作流 synthetic-3step 完成：")).toBeTrue();
  });
});

describe("T1 简报直投 · failed", () => {
  test("runPi 抛错 → note 即简报（截首行/200）+ run_failed 帧 + 简报消息", async () => {
    const { store, eventBus, runLifecycle } = setup(failStub);
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));

    const r = await runLifecycle.start({ conversationId: "c1", workflowId: "brand-research", input: { brand: "失败车" }, approved: true });
    await delayUntil(() => frames.some((f) => f.type === "run_failed"));

    const row = store.runs.getRun((r as { runId: string }).runId)!;
    expect(row.status).toBe("failed");
    expect(row.brief).toBe("boom");
    const msgs = store.chat.listMessages("c1");
    expect(msgs[msgs.length - 1].content).toBe("📋 工作流 brand-research 失败：boom");
    expect(frames.some((f) => f.type === "block_start")).toBeTrue();
  });
});

// #48/T6（ADR-0025 决策 9/10）：路由重构 e2e——POST /messages 全链（重启 run → 挂起强制卡 → 点卡程序化轮，
// 零 LLM / 免 429 / 双击幂等 / 自主卡滑 LLM / run 事件不再起 turn）。计数 stub 测 LLM turn 数。
describe("T6 #48 路由重构 · （真 HTTP POST + 计数 runPiStream）", () => {
  function routeSetup() {
    const store = createStores(openDbMigrated(":memory:"));
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "dev-user", title: "t" }); // 有 title → 跳过自动命名（不占 LLM 计数）
    const eventBus = new EventBus();
    const queues = new ConversationQueues();
    const runLifecycle = new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: okStub });
    let llmTurns = 0;
    const factory = (): ConfiguredRunPiStream => async (call) => {
      llmTurns++;
      call.onBlock?.({ op: "start", blockId: `b${llmTurns}`, kind: "text" });
      call.onBlock?.({ op: "delta", blockId: `b${llmTurns}`, delta: "ok" });
      call.onBlock?.({ op: "end", blockId: `b${llmTurns}` });
      return { text: "ok", messages: [], toolResults: [] };
    };
    const deps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore: new UserStore(openDbMigrated(":memory:")), streamRegistry: new StreamRegistry(),
      workspaceStore: new WorkspaceStore(openDbMigrated(":memory:")),
      eventBus, conversationQueues: queues, runLifecycle, runPiStreamFactory: factory,
    };
    const app = createApp(deps);
    const send = (content: string, inReplyTo?: number) =>
      app.request(`/conversations/c1/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(inReplyTo === undefined ? { content } : { content, inReplyTo }),
      });
    return { store, eventBus, queues, app, runLifecycle, llmCount: () => llmTurns, send };
  }

  test("run 终态不再起事件 turn（零 LLM 直投）：synthetic 一路 completed 计数 0", async () => {
    const { eventBus, runLifecycle, llmCount } = routeSetup();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const started = await runLifecycle.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {} });
    const runId = (started as any).runId as string;
    await delayUntil(() => frames.some((f) => f.type === "run_suspended"));
    await runLifecycle.resume(runId, { decision: "accept" });
    await delayUntil(() => frames.some((f) => f.type === "run_completed"));
    expect(llmCount()).toBe(0); // 无事件 turn（旧行为会 +1 转述）
  });

  test("挂起强制卡点选 → 程序化轮：零 LLM、免入队、cardAnswered 旗标、resume 续跑 + 简报", async () => {
    const { store, eventBus, queues, runLifecycle, llmCount, send } = routeSetup();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const started = await runLifecycle.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {} });
    const runId = (started as any).runId as string;
    await delayUntil(() => frames.some((f) => f.type === "hitl_request"));
    const qid = store.hitl.getPendingByRun(runId)!.id;

    const r = await send("接受", qid);
    expect(r.status).toBe(202);
    await delayUntil(() => store.runs.getRun(runId)!.status === "completed");
    expect(llmCount()).toBe(0); // 点卡不产生 LLM turn（程序化轮）
    const clicked = frames.find((f) => f.type === "user_message" && f.content === "接受");
    expect(clicked).toBeTruthy();
    expect(clicked.cardAnswered).toBeTrue(); // 跳轮旗标（前端免 LLM 占位）
    expect(store.hitl.getQuestion(qid)!.status).toBe("answered");
    const msgs = store.chat.listMessages("c1");
    expect(msgs.at(-1)!.content.startsWith("📋 工作流 synthetic-3step 完成：")).toBeTrue(); // 续跑完成 → 简报
  });

  test("双击已答卡 → 幂等 ack（第二次不二次起轮、不二次派发）", async () => {
    const { store, eventBus, runLifecycle, llmCount, send } = routeSetup();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const started = await runLifecycle.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {} });
    const runId = (started as any).runId as string;
    await delayUntil(() => frames.some((f) => f.type === "hitl_request"));
    const qid = store.hitl.getPendingByRun(runId)!.id;
    await send("接受", qid);
    await delayUntil(() => store.runs.getRun(runId)!.status === "completed");
    const once = store.hitl.getQuestion(qid)!;
    const r2 = await send("接受", qid); // 双击
    expect(r2.status).toBe(202);
    expect(llmCount()).toBe(0); // 幂等 ack：不二次起轮
    expect(store.hitl.getQuestion(qid)!.answeredAt).toBe(once.answeredAt); // 不二次写
  });

  test("自主卡点选 → 卡收口（answer=选项文本）+ LLM 轮照跑（pi 继续对话，不跳轮）", async () => {
    const { store, runLifecycle, llmCount, send } = routeSetup();
    const autoId = store.hitl.createQuestion({
      conversationId: "c1", kind: "ask", runId: null, prompt: "澄清：目标市场？", options: ["是", "否"],
    });
    const before = llmCount();
    const r = await send("是", autoId);
    expect(r.status).toBe(202);
    await delayUntil(() => llmCount() === before + 1); // 答案消费者是 pi → 不跳轮（决策 10 修订）
    const q = store.hitl.getQuestion(autoId)!;
    expect(q.status).toBe("answered"); // 问题 solved——打字/点选即收口（不再永久 pending）
    expect(q.answer).toBe("是"); // 用户回答上卡
  });

  test("429 分轨：队列满时点卡仍 202 + resume 执行；文字消息 → 429", async () => {
    const { store, eventBus, queues, runLifecycle, send } = routeSetup();
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));
    const started = await runLifecycle.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {} });
    const runId = (started as any).runId as string;
    await delayUntil(() => frames.some((f) => f.type === "hitl_request"));
    const qid = store.hitl.getPendingByRun(runId)!.id;

    // 塞满 HTTP FIFO（5 个永不 resolve 的 turn）
    for (let i = 0; i < 5; i++) queues.enqueueHttpTurn("c1", () => new Promise(() => {}));
    // 文字消息 → 429（LLM 轮路径被队列满拒，消息未落）
    const text = await send("你好");
    expect(text.status).toBe(429);
    // 点卡 → 仍 202（程序化轮不入队、免 429——ADR-0025 决策 9 净修复）
    const card = await send("接受", qid);
    expect(card.status).toBe(202);
    await delayUntil(() => store.runs.getRun(runId)!.status === "completed");
    expect(store.hitl.getQuestion(qid)!.status).toBe("answered");
  });
});

describe("T1 read_run 8k 封顶", () => {
  test("latestOutput stringify 截 8000 + 尾注；短输出原样", () => {
    const store = createStores(openDbMigrated(":memory:"));
    const registry = new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus: new EventBus(), runPiFactory: okStub });

    store.runs.createRun({ runId: "r-short", workflowId: "w", workspaceId: "ws_company", input: {}, conversationId: null });
    store.runs.appendLog("r-short", { stepId: "s", status: "completed", output: { text: "短" } });
    const short = registry.read("r-short")!;
    expect(short.latestOutput).toEqual({ text: "短" }); // 短原样（对象不串化）

    store.runs.createRun({ runId: "r-long", workflowId: "w", workspaceId: "ws_company", input: {}, conversationId: null });
    store.runs.appendLog("r-long", { stepId: "s", status: "completed", output: { text: "x".repeat(10000) } });
    const long = registry.read("r-long")!;
    expect(typeof long.latestOutput).toBe("string");
    expect((long.latestOutput as string).length).toBe(READ_TRUNCATE + READ_FOOTER.length);
    expect((long.latestOutput as string)).toContain("已截断");
    expect((long.latestOutput as string)).toContain("全文见 DB/文件");
  });
});