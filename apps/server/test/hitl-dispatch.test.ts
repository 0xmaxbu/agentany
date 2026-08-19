// 统一卡应答 dispatch 测试（#28 重构）：消息绑定 questionId（inReplyTo）→ kind handler 确定性执行。
// 收编 #18 approvals/decide 与 #28 scheduled-tasks/confirm——一套机制三种卡。
// seam：HTTP（POST /conversations/:id/messages 带 inReplyTo）+ 直查 store 断言副作用。
import { describe, test, expect, beforeEach } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { RunLifecycle } from "../src/runs/lifecycle";
import { deterministicResumeData } from "../src/chat/hitl-dispatch";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const JH = { "content-type": "application/json" };
const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });

async function setup() {
  const db = openDbMigrated(":memory:");
  const store = createStores(db);
  const userStore = new UserStore(db);
  const eventBus = new EventBus();
  await userStore.createUser({ username: "m1", password: "pw-long-enough", role: "member" });
  await userStore.createUser({ username: "ad", password: "pw-long-enough", role: "admin" });
  const m1 = userStore.getUserByUsername("m1")!;
  const ad = userStore.getUserByUsername("ad")!;
  const deps: RunDeps = {
    runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore, streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store.chat),
    eventBus,
    runLifecycle: new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubFactory }),
  };
  store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
  store.chat.createConversation({ id: "c2", workspaceId: "ws_company", userId: m1.id });
  const app = createApp(deps);
  const login = async (u: string) => {
    const r = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: u, password: "pw-long-enough" }) });
    return `Bearer ${(await r.json() as any).token}`;
  };
  const send = (conv: string, token: string, content: string, inReplyTo?: number) =>
    app.request(`/conversations/${conv}/messages`, {
      method: "POST", headers: { ...JH, authorization: token },
      body: JSON.stringify(inReplyTo === undefined ? { content } : { content, inReplyTo }),
    });
  return { deps, store, userStore, eventBus, app, m1, ad, login, send, queues: new ConversationQueues() };
}

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); });

describe("dispatch · task 卡（消息绑定确认）", () => {
  test("inReplyTo 指向 task pending 卡，content=确认创建 → 服务端直建 + 产出会话 + 卡 answered", async () => {
    const qid = ctx.store.hitl.createQuestion({
      conversationId: "c1", kind: "task", prompt: "创建任务卡",
      options: ["确认创建", "取消"],
      input: { displayName: "新闻汇总", cron: "0 */4 * * *", prompt: "读新闻", next3: [] },
    });
    const tok = await ctx.login("m1");
    const frames: any[] = [];
    ctx.eventBus.subscribe("c1", (f) => frames.push(f));
    const r = await ctx.send("c1", tok, "确认创建", qid);
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 30));
    const mine = ctx.deps.taskStore!.listTasks({ creatorId: ctx.m1.id });
    expect(mine).toHaveLength(1);
    expect(mine[0].displayName).toBe("新闻汇总");
    expect(ctx.store.chat.getConversation(mine[0].outputConversationId!)!.title).toBe("新闻汇总");
    expect(ctx.store.hitl.getQuestion(qid)!.status).toBe("answered");
    expect(frames.some((f) => f.type === "hitl_answered")).toBe(true);
  });

  test("content=取消 → 卡 answered、不建任务", async () => {
    const qid = ctx.store.hitl.createQuestion({
      conversationId: "c1", kind: "task", prompt: "创建任务卡",
      options: ["确认创建", "取消"],
      input: { displayName: "x", cron: "0 */4 * * *", prompt: "p" },
    });
    const tok = await ctx.login("m1");
    await ctx.send("c1", tok, "取消", qid);
    await new Promise((res) => setTimeout(res, 20));
    expect(ctx.store.hitl.getQuestion(qid)!.status).toBe("answered");
    expect(ctx.deps.taskStore!.listTasks({ creatorId: ctx.m1.id })).toHaveLength(0);
  });

  test("他人消息绑我的卡 → 不生效（卡仍 pending，任务不建）", async () => {
    const qid = ctx.store.hitl.createQuestion({
      conversationId: "c1", kind: "task", prompt: "卡",
      options: ["确认创建", "取消"],
      input: { displayName: "x", cron: "0 */4 * * *", prompt: "p" },
    });
    const tok = await ctx.login("ad"); // admin 也不代确认（自建自批）
    await ctx.send("c1", tok, "确认创建", qid);
    await new Promise((res) => setTimeout(res, 20));
    expect(ctx.store.hitl.getQuestion(qid)!.status).toBe("pending");
    expect(ctx.deps.taskStore!.listTasks({ creatorId: ctx.m1.id })).toHaveLength(0);
  });
});

describe("dispatch · approval 卡（收编 #18）", () => {
  test("content=批准（options[0]）→ decide approve + createRun（approved:true 跳 policy）+ backfill", async () => {
    const qid = ctx.store.hitl.createQuestion({
      conversationId: "c1", kind: "approval", workflowId: "brand-research", input: { brand: "x" },
      prompt: "需审批 · brand-research", options: ["批准", "拒绝"],
    });
    const tok = await ctx.login("m1");
    const r = await ctx.send("c1", tok, "批准", qid);
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 50));
    const q = ctx.store.hitl.getQuestion(qid)!;
    expect(q.status).toBe("answered");
    expect((q.answer as any).decision).toBe("approve");
    expect(q.decidedBy).toBe(ctx.m1.id);
    expect(q.runId).toBeTruthy(); // backfill
    expect(ctx.store.runs.getRun(q.runId!)!.workflowId).toBe("brand-research");
  });

  test("content=拒绝（options[1]）→ decide deny、不建 run", async () => {
    const qid = ctx.store.hitl.createQuestion({
      conversationId: "c1", kind: "approval", workflowId: "brand-research", input: {},
      prompt: "需审批", options: ["批准", "拒绝"],
    });
    const tok = await ctx.login("m1");
    await ctx.send("c1", tok, "拒绝", qid);
    await new Promise((res) => setTimeout(res, 30));
    const q = ctx.store.hitl.getQuestion(qid)!;
    expect((q.answer as any).decision).toBe("deny");
    expect(q.runId).toBeNull();
  });

  test("非卡主（他人会话消息）→ 不生效", async () => {
    // 卡在 c1（m1 的会话），m1 之外的登录者无法向 c1 发消息（404 路由守卫）——已由会话守卫保证。
    // 此处测：卡主身份与消息发送者一致才 dispatch（m1 发自 c2 绑 c1 的卡 → conv 不匹配不生效）。
    const qid = ctx.store.hitl.createQuestion({
      conversationId: "c1", kind: "approval", workflowId: "brand-research", input: {},
      prompt: "需审批", options: ["批准", "拒绝"],
    });
    const tok = await ctx.login("m1");
    await ctx.send("c2", tok, "批准", qid); // 错会话
    await new Promise((res) => setTimeout(res, 20));
    expect(ctx.store.hitl.getQuestion(qid)!.status).toBe("pending");
  });
});

describe("dispatch · ask 卡（选项点击确定性 resume）", () => {
  test("挂起即引擎直建强制卡；点选项 → 确定性 resume + markAnswered", async () => {
    // synthetic-3step 的 review 是 ask 步：挂起同事务直建强制卡（options + values 快照 + resumeSchema）
    const reg = ctx.deps.runLifecycle!;
    const start = await reg.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {} });
    expect(start.status).toBe("running");
    const runId = (start as any).runId as string;
    await new Promise((res) => setTimeout(res, 150)); // 等 suspend + 引擎直建卡
    expect(ctx.store.runs.getRun(runId)!.status).toBe("suspended");

    const qid = ctx.store.hitl.getPendingByRun(runId)!.id; // 引擎强制卡（非手动建）
    const card = ctx.store.hitl.getQuestion(qid)!;
    expect(card.kind).toBe("ask");
    expect(card.options).toEqual(["接受", "偏移 +1 重跑"]);
    expect(card.resumeSchema).toBeTruthy();

    const tok = await ctx.login("m1");
    await ctx.send("c1", tok, "接受", qid);
    await new Promise((res) => setTimeout(res, 150));
    const q = ctx.store.hitl.getQuestion(qid)!;
    expect(q.status).toBe("answered");
    expect((q.answer as any).decision).toBe("accept"); // label→value 快照查表，确定性
    const after = ctx.store.runs.getRun(runId)!;
    expect(["running", "suspended", "completed"]).toContain(after.status); // 已 resume
  });

  test("打字回答（不带 inReplyTo）→ 卡不动，仍走 LLM 判答老路", async () => {
    const qid = ctx.store.hitl.createQuestion({
      conversationId: "c1", kind: "ask", runId: "r_x", prompt: "q",
      options: ["a", "b"], resumeSchema: { _t: "object", shape: { decision: { _t: "enum", vals: ["a", "b"] } } },
    });
    const tok = await ctx.login("m1");
    const r = await ctx.send("c1", tok, "我觉得都行，帮我选 a 吧");
    expect(r.status).toBe(202); // 正常消息
    expect(ctx.store.hitl.getQuestion(qid)!.status).toBe("pending"); // 未被 dispatch
  });

  test("复杂 schema（无 value 无 enum）点选 → slide：卡保持 pending、不落卡（pi 下轮归一化）", async () => {
    // ADR-0025 决策 10：落卡形态删除——不可确定性映射 → handled:false 滑 LLM 轮（不 markDecided）
    const qid = ctx.store.hitl.createQuestion({
      conversationId: "c1", kind: "ask", runId: "r_y", prompt: "q",
      options: ["方案A", "方案B"],
      resumeSchema: { _t: "object", shape: { plan: { _t: "string" }, reason: { _t: "string" } } },
    });
    const tok = await ctx.login("m1");
    await ctx.send("c1", tok, "方案A", qid);
    await new Promise((res) => setTimeout(res, 30));
    const q = ctx.store.hitl.getQuestion(qid)!;
    expect(q.status).toBe("pending"); // slide：卡保持 pending，[待处理提问] 注入仍在，pi 下轮归一化
    expect(q.answer).toBeNull();
  });

  test("自主卡（runId null）点选 → 确定性收口（answer=选项文本）+ 不跳轮（pi 继续对话）", async () => {
    const qid = ctx.store.hitl.createQuestion({
      conversationId: "c1", kind: "ask", runId: null, prompt: "澄清：目标市场？",
      options: ["是", "否"],
    });
    const tok = await ctx.login("m1");
    const r = await ctx.send("c1", tok, "是", qid);
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 30));
    const q = ctx.store.hitl.getQuestion(qid)!;
    expect(q.status).toBe("answered"); // 决策 10 修订：回答即 solved，不再永久 pending
    expect(q.answer).toBe("是"); // 用户回答上卡（前端卡显示问题+回答）
  });

  
  test("双击已答强制卡 → 幂等 ack：消息照常落库、不二次派发/起轮", async () => {
    const reg = ctx.deps.runLifecycle!;
    const start = await reg.start({ conversationId: "c1", workflowId: "synthetic-3step", input: {} });
    const runId = (start as any).runId as string;
    await new Promise((res) => setTimeout(res, 150));
    const qid = ctx.store.hitl.getPendingByRun(runId)!.id;
    const tok = await ctx.login("m1");
    await ctx.send("c1", tok, "接受", qid);
    await new Promise((res) => setTimeout(res, 100));
    const once = ctx.store.hitl.getQuestion(qid)!;
    expect(once.status).toBe("answered");
    await ctx.send("c1", tok, "接受", qid); // 双击
    await new Promise((res) => setTimeout(res, 30));
    const twice = ctx.store.hitl.getQuestion(qid)!;
    expect(twice.status).toBe("answered");
    expect(twice.answer).toEqual(once.answer); // 不二次派发
    expect(twice.answeredAt).toBe(once.answeredAt); // 不二次写
  });
});

describe("deterministicResumeData（#47/T5：快照查表 vs enum 对位）", () => {
  function makeQ(over: Partial<Parameters<typeof ctx.store.hitl.createQuestion>[0]> = {}): any {
    const store = ctx.store;
    return store.hitl.getQuestion(store.hitl.createQuestion({ conversationId: "c1", prompt: "q", options: ["a", "b"], ...over }));
  }
  test("显式 value 快照命中 → 返对应 value（label→value 查表）", () => {
    const q = makeQ({ values: [{ label: "a", value: { selected: "x" } }, { label: "b", value: 42 }] });
    expect(deterministicResumeData(q, 0)).toEqual({ selected: "x" });
    expect(deterministicResumeData(q, 1)).toBe(42);
  });
  test("无快照 → undefined（enum 对位已随旧手写卡退役——run 绑定卡恒由引擎直建带 values 快照）", () => {
    const q = makeQ({ resumeSchema: { _t: "object", shape: { decision: { _t: "enum", vals: ["accept", "redirect"] }, focus: { _t: "optional", inner: { _t: "string" } } } } });
    expect(deterministicResumeData(q, 1)).toBeUndefined(); // 不可映射 → slide LLM 轮
  });
  test("无快照无 enum → undefined（slide）", () => {
    const q = makeQ({ resumeSchema: { _t: "object", shape: { plan: { _t: "string" } } } });
    expect(deterministicResumeData(q, 0)).toBeUndefined();
  });
});

describe("dispatch · 幂等与边界", () => {
  test("重复确认（已 answered 的卡）→ 第二次消息正常落库不重复执行", async () => {
    const qid = ctx.store.hitl.createQuestion({
      conversationId: "c1", kind: "task", prompt: "卡",
      options: ["确认创建", "取消"], input: { displayName: "x", cron: "0 */4 * * *", prompt: "p" },
    });
    const tok = await ctx.login("m1");
    await ctx.send("c1", tok, "确认创建", qid);
    await new Promise((res) => setTimeout(res, 30));
    const r2 = await ctx.send("c1", tok, "确认创建", qid); // 重复
    expect(r2.status).toBe(202);
    expect(ctx.deps.taskStore!.listTasks({ creatorId: ctx.m1.id })).toHaveLength(1); // 不重复建
  });

  test("inReplyTo 指向不存在的卡 → 消息正常处理（202），无副作用", async () => {
    const tok = await ctx.login("m1");
    const r = await ctx.send("c1", tok, "普通消息", 99999);
    expect(r.status).toBe(202);
  });

  test("专用路由已删：/approvals/:id/decide 与 /scheduled-tasks/confirm/:id → 404", async () => {
    const tok = await ctx.login("m1");
    expect((await ctx.app.request("/approvals/1/decide", { method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ decision: "approve" }) })).status).toBe(404);
    expect((await ctx.app.request("/scheduled-tasks/confirm/1", { method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ decision: "confirm" }) })).status).toBe(404);
  });
});
