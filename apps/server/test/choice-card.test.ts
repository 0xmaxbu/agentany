// T6（#61）：选择卡多卡文本消歧。seam：
//   - handleImInbound 三分支直测（0/1/>1 ask 卡）+ pending 缓存（TTL/覆盖）
//   - 渲染：renderSelectCard 结构（仅 prompt、value={selectQuestionId}）
//   - e2e（fakeFeishuWs + client.onCard=handleCardAction(deps, pending) + makeFeishuInbound(deps, transport, pending)）：
//     两卡并存 → 打字 → 选择卡 → 点选 → 缓存文本判答收口 → 更新卡/toast；并发双点 CAS；归一化失败重试提示
import { describe, test, expect, beforeEach } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { RunRegistry } from "../src/runs/registry";
import { ImStore } from "../src/im/store";
import { handleImInbound } from "../src/im/inbound";
import { makePendingTextCache } from "../src/im/pending-text";
import { renderSelectCard } from "../src/im/card";
import { makeFeishuInbound } from "../src/im/feishu/inbound";
import { handleCardAction } from "../src/im/feishu/card-action";
import { FeishuTransport } from "../src/im/feishu/transport";
import { FeishuLongConnection } from "../src/im/feishu/long-connection";
import { fakeFeishuWs, fakeFeishuFetch, receiveTextEvent, cardActionEvent } from "./fake-feishu";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi, ConfiguredRunPiStream } from "../src/pi/runPi-factory";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(10); }
};

const stubRunPiFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });

/** 判定 stub：注入含 [待处理提问] 的段 + 程序化 answer_question 收口（任意 ask 卡，选择卡判答成功侧）。 */
const makeJudgeStream = (deps: RunDeps, log: { calls: number }): ConfiguredRunPiStream => async (call) => {
  log.calls++;
  const appends = (call as any).appendSystemPrompt ?? [];
  const askEl = appends.find((s: string) => s.startsWith("[待处理提问]") && /answer_question\(\d+/.test(s));
  if (askEl) {
    const qid = askEl.match(/answer_question\((\d+)/)?.[1];
    if (qid) {
      const row = deps.hitlStore.markQuestionAnswered(Number(qid), { plan: "按 IM 文本归一化" });
      if (row) deps.eventBus?.publish(row.conversationId, { type: "hitl_answered", questionId: row.id, answer: { plan: "按 IM 文本归一化" }, kind: "ask" });
    }
  }
  call.onBlock?.({ op: "start", blockId: "b1", kind: "text" });
  call.onBlock?.({ op: "end", blockId: "b1" });
  return { text: "回答已记录。", messages: [], toolResults: [] };
};

/** 归一化失败 stub：判答轮只给空输出，不标 answered（卡保持 pending）。 */
const makeFailStream = (deps: RunDeps, log: { calls: number }): ConfiguredRunPiStream => async (call) => {
  log.calls++;
  call.onBlock?.({ op: "start", blockId: "b1", kind: "text" });
  call.onBlock?.({ op: "end", blockId: "b1" });
  return { text: "抱歉，无法据此推进。", messages: [], toolResults: [] };
};

function setup(streamCtor: (deps: RunDeps, log: { calls: number }) => ConfiguredRunPiStream = makeJudgeStream) {
  const db = openDbMigrated(":memory:");
  const store = createStores(db);
  const userStore = new UserStore(db);
  const eventBus = new EventBus();
  const queues = new ConversationQueues();
  const log = { calls: 0 };
  const pending = makePendingTextCache(10 * 60 * 1000);
  const deps: RunDeps = {
    runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore,
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store.chat),
    eventBus, conversationQueues: queues, imStore: new ImStore(db),
    runRegistry: new RunRegistry({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubRunPiFactory }),
    runPiStreamFactory: () => streamCtor(deps, log),
  };
  const fake = fakeFeishuWs();
  const transport = new FeishuTransport({ appId: "cli_x", appSecret: "s", baseUrl: "https://fake.feishu", fetchFn: fakeFeishuFetch(fake.app) });
  const inbound = makeFeishuInbound(deps, transport, pending);
  const lc = new FeishuLongConnection({
    appId: "cli_x", appSecret: "s", baseUrl: "https://fake.feishu", fetchFn: fakeFeishuFetch(fake.app),
    onEvent: (p) => { void inbound(p).catch(console.error); },
    onCard: (p) => handleCardAction(deps, p, pending, (openId, content) => transport.send(openId, { text: content })),
    pingIntervalMs: 40, log: () => {},
  });
  return { db, store, userStore, eventBus, queues, deps, fake, transport, inbound, lc, pending, log };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => { ctx = setup(); });

const newUser = async (u: string) => { await ctx.userStore.createUser({ username: u, password: "pw-long-enough", role: "member" }); return ctx.userStore.getUserByUsername(u)!; };

describe("handleImInbound 三分支（扫描全部 ask 卡）", () => {
  // 每 boot 绑一个独立 openId，避免同用户多卡混杂跨场景
  const boot = async (n: number, tag: string, openId: string) => {
    let u = ctx.userStore.getUserByUsername(tag);
    if (!u) { await ctx.userStore.createUser({ username: tag, password: "pw-long-enough", role: "member" }); u = ctx.userStore.getUserByUsername(tag)!; }
    ctx.deps.imStore!.bind(openId, "feishu", u.id);
    ctx.store.chat.createConversation({ id: `c_${tag}_${n}`, workspaceId: "ws_company", userId: u.id });
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(ctx.store.hitl.createQuestion({ conversationId: `c_${tag}_${n}`, runId: null, prompt: `澄清${i}`, options: ["A"] }));
    return { u, ids };
  };

  test("0 张 ask → discarded；1 张 → processed（判答）；>1 张 → choice_needed + 缓存 + candidates", async () => {
    await boot(0, "u0", "ou_9");
    expect((await handleImInbound(ctx.deps, { imUserId: "ou_9", platform: "feishu", text: "x" }, ctx.pending)).status).toBe("discarded"); // 无卡

    const { ids } = await boot(3, "m1", "ou_1"); // >1
    const r = await handleImInbound(ctx.deps, { imUserId: "ou_1", platform: "feishu", text: "我想答第一张" }, ctx.pending);
    expect(r.status).toBe("choice_needed");
    expect(r.candidates!.map((c) => c.questionId)).toEqual(ids); // 全部 ask 卡的 prompt（仅）
    expect(ctx.pending.get("ou_1")).toBe("我想答第一张"); // 文本已缓存
    const { ids: ids2 } = await boot(1, "m2", "ou_2"); // 恰一张（独立用户）→ 直接判答
    const r2 = await handleImInbound(ctx.deps, { imUserId: "ou_2", platform: "feishu", text: "答这张" }, ctx.pending);
    expect(r2.status).toBe("processed");
    expect(ctx.store.hitl.getQuestion(ids2[0])!.status).toBe("answered");
  });

  test("缓存：新文本覆盖；TTL 过期清理", async () => {
    await boot(2, "m1", "ou_1");
    await handleImInbound(ctx.deps, { imUserId: "ou_1", platform: "feishu", text: "第一句" }, ctx.pending);
    await handleImInbound(ctx.deps, { imUserId: "ou_1", platform: "feishu", text: "第二句覆盖" }, ctx.pending);
    expect(ctx.pending.get("ou_1")).toBe("第二句覆盖"); // 覆盖
    let wall = 1_000_000;
    const clock = () => wall;
    const expired = makePendingTextCache(1000, clock);
    expired.set("ou_x", "old");
    wall += 2000; // 快进退过期
    expect(expired.get("ou_x")).toBeUndefined(); // TTL 过 → undefined（清）
  });
});

describe("renderSelectCard（结构）", () => {
  test("每张卡一个按钮：仅 prompt（截断）+ value={selectQuestionId}；不展开选项", () => {
    const card: any = renderSelectCard([
      { questionId: 3, prompt: "预算区间是多少？" },
      { questionId: 7, prompt: "这道题目特别长，需要被截断才能放进按钮里面微软雅黑两排装不下，四十个字以内根本展示不完的场景" },
    ]);
    expect(card.schema).toBe("2.0");
    const btns: any[] = card.body.elements.filter((e: any) => e.tag === "button");
    expect(btns).toHaveLength(2);
    expect(btns[0].text.content).toBe("预算区间是多少？");
    expect(btns[1].text.content.endsWith("…")).toBe(true); // 长 prompt 截断
    expect(btns[0].behaviors[0].value).toEqual({ selectQuestionId: 3 });
    expect(card.body.elements.some((e: any) => e.tag === "action")).toBe(false); // 2.0 无 action 容器（live smoke 修复）
  });
});

describe("e2e：两卡并存 → 选择卡 → 点选判答", () => {
  const e2eUser = async (u: string) => {
    if (!ctx.userStore.getUserByUsername(u)) await ctx.userStore.createUser({ username: u, password: "pw-long-enough", role: "member" });
    return ctx.userStore.getUserByUsername(u)!;
  };
  const selEvent = (openId: string, qid: number) => ({
    schema: "2.0",
    header: { event_id: "ev_sel", event_type: "card.action.trigger", create_time: "t", app_id: "a", tenant_key: "t" },
    event: {
      operator: { tenant_key: "t", open_id: openId, union_id: "u", user_id: "u" },
      action: { value: { selectQuestionId: qid }, tag: "button" },
      context: {}, token: "t",
    },
  });

  test("打字 → 选择卡发出（interactive）→ 点选目标卡 → 缓存文本判答收口 + 更新卡/toast；二次点选 → 已处理", async () => {
    const m1 = await e2eUser("m1");
    ctx.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.deps.imStore!.bind("ou_1", "feishu", m1.id);
    const q1 = ctx.store.hitl.createQuestion({ conversationId: "c1", runId: null, prompt: "预算？", options: ["<10w"] });
    const q2 = ctx.store.hitl.createQuestion({ conversationId: "c1", runId: null, prompt: "方向？", options: ["A方向"] });
    ctx.lc.start();
    await delayUntil(() => ctx.fake.state.wsClients === 1, 3000);

    // 打字 → 选择卡（interactive，按钮 value={selectQuestionId}）
    await ctx.inbound(receiveTextEvent("ou_1", "不超过 10 万"));
    await delayUntil(() => ctx.fake.state.sent.some((s) => s.msgType === "interactive"), 2000);
    const selCard = ctx.fake.state.sent.find((s) => s.msgType === "interactive")!;
    const selector = selCard.content as any;
    expect(selector.body.elements[1].actions).toBeUndefined(); // 2.0 无 action 容器（live smoke 修复）
    const buttons: any[] = selector.body.elements.filter((e: any) => e.tag === "button");
    expect(buttons.map((b) => b.behaviors[0].value.selectQuestionId)).toEqual([q1, q2]);

    // 点选第 2 张（q2）→ ack 立即「已收到」（3s 窗内不跑 LLM）→ 异步判答收口 → 回执文本「已处理」
    const { ack } = await ctx.fake.pushCardAction(selEvent("ou_1", q2));
    expect((ack.data as any).toast).toEqual({ type: "info", content: "已收到，正在处理…" });
    await delayUntil(() => ctx.store.hitl.getQuestion(q2)!.status === "answered", 3000);
    expect(ctx.store.hitl.getQuestion(q2)!.status).toBe("answered");
    await delayUntil(() => ctx.fake.state.sent.some((s) => s.msgType === "text" && (s.content as any)?.text === "已处理"), 3000);
    expect(ctx.fake.state.sent.some((s) => s.msgType === "text" && (s.content as any)?.text === "已处理")).toBe(true); // 异步回执经独立 send 通道
    // 缓存已消费：再点另一张（q1）→ 过期提示（旧选卡已失效）
    const { ack: ack2 } = await ctx.fake.pushCardAction(selEvent("ou_1", q1));
    expect((ack2.data as any).toast.content).toContain("过期");

    ctx.lc.stop(); ctx.fake.close();
  });

  test("并发双点（同一目标 q2）→ 卡恰收口一次；两发都有效 ack（CAS 幂等，无 error toast）", async () => {
    const m1 = await e2eUser("m1");
    ctx.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.deps.imStore!.bind("ou_1", "feishu", m1.id);
    ctx.store.hitl.createQuestion({ conversationId: "c1", runId: null, prompt: "预算？", options: ["<10w"] });
    const q2 = ctx.store.hitl.createQuestion({ conversationId: "c1", runId: null, prompt: "方向？", options: ["A方向"] });
    ctx.lc.start();
    await delayUntil(() => ctx.fake.state.wsClients === 1, 3000);
    await ctx.inbound(receiveTextEvent("ou_1", "十 万"));
    await delayUntil(() => ctx.fake.state.sent.some((s) => s.msgType === "interactive"), 2000);

    const a = ctx.fake.pushCardAction(selEvent("ou_1", q2));
    const b = ctx.fake.pushCardAction(selEvent("ou_1", q2));
    await delayUntil(() => ctx.store.hitl.getQuestion(q2)!.status === "answered", 3000);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ctx.store.hitl.getQuestion(q2)!.status).toBe("answered"); // 恰 1 次收口（DB CAS）
    // 两发 ack 都即时且无 error（幂等分支：首发「已收到」/后发「该卡已被处理」）；回执「已处理」恰达一次（CAS 单收口）
    const toasts = [ra.ack.data, rb.ack.data].map((d: any) => (d as any)?.toast).filter(Boolean).map((t: any) => t.content);
    expect(toasts.every((t: any) => t === "已收到，正在处理…" || t === "该卡已被处理")).toBe(true);
    expect(toasts.some((t: any) => t === "已收到，正在处理…")).toBe(true);
    expect(ctx.fake.state.sent.filter((s) => s.msgType === "text" && (s.content as any)?.text === "已处理")).toHaveLength(1);
    ctx.lc.stop(); ctx.fake.close();
  });

  test("归一化失败（判答不落 answered）→ ack「已收到」+ 回执「暂时无法据此推进」 + 卡 pending + 缓存保留可重试", async () => {
    const fail = setup(makeFailStream);
    const m1 = await (async () => { if (!fail.userStore.getUserByUsername("m")) await fail.userStore.createUser({ username: "m", password: "pw-long-enough", role: "member" }); return fail.userStore.getUserByUsername("m")!; })();
    fail.store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    fail.deps.imStore!.bind("ou_1", "feishu", m1.id);
    const q1 = fail.store.hitl.createQuestion({ conversationId: "c1", runId: null, prompt: "预算？", options: ["<10w"] });
    fail.store.hitl.createQuestion({ conversationId: "c1", runId: null, prompt: "方向？", options: ["A"] });
    fail.lc.start();
    await delayUntil(() => fail.fake.state.wsClients === 1, 3000);
    await fail.inbound(receiveTextEvent("ou_1", "十 万"));
    await delayUntil(() => fail.fake.state.sent.some((s) => s.msgType === "interactive"), 2000);

    const { ack } = await fail.fake.pushCardAction(selEvent("ou_1", q1));
    expect((ack.data as any).toast.content).toBe("已收到，正在处理…"); // 3s 窗即时 ack
    await delayUntil(() => fail.fake.state.sent.some((s) => s.msgType === "text" && (s.content as any)?.text.includes("暂时无法据此推进")), 3000);
    expect(fail.store.hitl.getQuestion(q1)!.status).toBe("pending"); // 未收口
    expect(fail.pending.get("ou_1")).toBe("十 万"); // 缓存保留 → 可重试
    fail.lc.stop(); fail.fake.close();
  });
});