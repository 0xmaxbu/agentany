// T2（#57）：飞书长连接 client + 文本入站。验证全部在假飞书（fake-feishu.ts 的真 WS server + 共享 pbbp2 codec）上，
// 无需真飞书。
// seam：
//   - codec：golden-bytes 单测（真 wire 字节，防对称编码 bug）+ round-trip
//   - client 协议：FeishuLongConnection + fakeFeishuWs → 真建连/真 ping/真 ack/分片合包
//   - 映射：mapFeishuEvent 纯函数（群聊/非文本/缺字段边界）
//   - e2e：绑定的用户 + pending ask 卡 → push 文本事件 → handleImInbound 判答收口 → 回复经 send 回发
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { RunLifecycle } from "../src/runs/lifecycle";
import { ImStore } from "../src/im/store";
import { FeishuTransport } from "../src/im/feishu/transport";
import { FeishuLongConnection, backoffDelayMs, shouldGiveUp, type ReconnectConfig } from "../src/im/feishu/long-connection";
import { mapFeishuEvent, makeFeishuInbound } from "../src/im/feishu/inbound";
import { encodeFrame, decodeFrame, headerValue } from "../src/im/feishu/pbbp2";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi, ConfiguredRunPiStream } from "../src/pi/runPi-factory";
import { fakeFeishuWs, fakeFeishuFetch, receiveTextEvent } from "./fake-feishu";

const stubRunPiFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(10); }
};

// ── codec：golden bytes + round-trip ──
describe("pbbp2 codec（真 wire 字节）", () => {
  test("golden：Frame{seqId:1,logId:2,service:3,method:1,headers:[type=event]} → 手算 hex", () => {
    const b = encodeFrame({ seqId: 1, logId: 2, service: 3, method: 1, payload: new Uint8Array(),
      headers: [{ key: "type", value: "event" }] });
    expect(Buffer.from(b).toString("hex")).toBe(
      // 08 01 seqId=1 | 10 02 logId=2 | 18 03 service=3 | 20 01 method=1 (data)
      // 2A 0D + Header{ 0A 04 "type" 12 05 "event" }
      "0801100218032001" + "2a0d" + "0a0474797065" + "12056576656e74",
    );
  });

  test("round-trip：带 payload 的 data 帧 → decode 等值", () => {
    const f = { seqId: 42, logId: 7, service: 3, method: 1,
      headers: [{ key: "type", value: "event" }, { key: "message_id", value: "om_x" }, { key: "sum", value: "1" }],
      payload: new TextEncoder().encode('{"a":1}') };
    const back = decodeFrame(encodeFrame(f));
    expect(back).toMatchObject({ seqId: 42, logId: 7, service: 3, method: 1 });
    expect(headerValue(back.headers, "type")).toBe("event");
    expect(headerValue(back.headers, "message_id")).toBe("om_x");
    expect(new TextDecoder().decode(back.payload)).toBe('{"a":1}');
  });
});

// ── 映射纯函数 ──
describe("mapFeishuEvent（事件 → 文本回流口径）", () => {
  test("p2p text → {openId,text}", () => {
    const r = mapFeishuEvent(receiveTextEvent("ou_1", "你好"));
    expect(r).toEqual({ openId: "ou_1", text: "你好" });
  });
  test("群聊（含 @）→ null（v1 只做单聊）", () => {
    const ev = receiveTextEvent("ou_1", "你好", { event: { message: { chat_type: "group" } } });
    expect(mapFeishuEvent(ev)).toBeNull();
  });
  test("非 text（image）→ null", () => {
    const ev = receiveTextEvent("ou_1", "x", { event: { message: { message_type: "image", content: "{}" } } });
    expect(mapFeishuEvent(ev)).toBeNull();
  });
  test("缺 sender_id.open_id → null", () => {
    const ev = receiveTextEvent("ou_1", "x", { event: { sender: { sender_id: {} } } });
    expect(mapFeishuEvent(ev)).toBeNull();
  });
  test("content 非合法 JSON → null", () => {
    const ev = receiveTextEvent("ou_1", "x", { event: { message: { content: "not-json" } } });
    expect(mapFeishuEvent(ev)).toBeNull();
  });
});

// ── 退避重连纯函数 ──
describe("退避重连（有界）", () => {
  const cfg: ReconnectConfig = { reconnectCount: 3, reconnectIntervalMs: 1000, reconnectNonceMs: 0 };
  test("count=3 → 第 4 次失败即放弃", () => {
    expect(shouldGiveUp(3, cfg)).toBe(false);
    expect(shouldGiveUp(4, cfg)).toBe(true);
  });
  test("count<0 → 永不放弃", () => {
    expect(shouldGiveUp(100000, { ...cfg, reconnectCount: -1 })).toBe(false);
  });
  test("interval 固定；nonce>0 时首退避在 (0, nonce) 抖动内", () => {
    const withNonce: ReconnectConfig = { reconnectCount: -1, reconnectIntervalMs: 1000, reconnectNonceMs: 500 };
    const d = backoffDelayMs(1, withNonce, () => 0.5);
    expect(d).toBe(1250); // 250 抖动 + 1000 间隔
    expect(backoffDelayMs(2, withNonce, () => 0)).toBe(1000);
  });
});

// ── 长连接 client 协议（真 WS 回环）──
describe("FeishuLongConnection（假飞书 WS）", () => {
  let fake: ReturnType<typeof fakeFeishuWs>;
  let events: unknown[];
  let lc: FeishuLongConnection;

  const connect = async () => {
    fake = fakeFeishuWs();
    events = [];
    lc = new FeishuLongConnection({
      appId: "cli_x", appSecret: "s_y", baseUrl: "https://fake.feishu",
      fetchFn: fakeFeishuFetch(fake.app),
      onEvent: (p) => { events.push(p); },
      pingIntervalMs: 40, log: () => {},
    });
    lc.start();
    await delayUntil(() => fake.state.wsClients === 1, 3000);
    return { fake, events, lc };
  };

  beforeEach(async () => { await connect(); });
  afterEach(() => { try { lc.stop(); } catch { /* 已停 */ } try { fake.close(); } catch { /* 已关 */ } });

  test("握手 endpoint（AppID/AppSecret 透传）→ 建连 → ping 心跳", async () => {
    expect(lc.statusNow).toBe("connected");
    expect(fake.state.wsClients).toBe(1);
    await delayUntil(() => fake.state.pings >= 1, 2000);
    expect(fake.state.pings).toBeGreaterThanOrEqual(1); // client 主动心跳（control 帧 type=ping）
  });

  test("push 事件 → onEvent 收到 + 立即 ack{code:200}（含 biz_rt + 同 message_id + 原 seqId）", async () => {
    const { ack } = await fake.pushEvent(receiveTextEvent("ou_1", "你好"));
    expect(ack.code).toBe(200);
    expect(ack.bizRt).not.toBeNull();
    expect(ack.seqId).toBe(0); // 原帧身份回传（fake 推的 seqId=0）
    expect(fake.state.acks).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect((events[0] as any).event.message.content).toContain("你好");
  });

  test("分片事件（sum=2）→ 合包后 onEvent 恰一次，payload 完整", async () => {
    const evt = receiveTextEvent("ou_1", "分片事件内容，超过半片长度以便拆分");
    await fake.pushEvent(evt, { chunks: 2 });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(evt); // 事件原样合一
    // ack 用最后一帧身份（message_id 一致）
    expect(fake.state.acks).toHaveLength(1);
    expect(fake.state.acks[0].code).toBe(200);
  });

  test("stop() → 退订（ws 关闭 + 不再收帧）", async () => {
    lc.stop();
    expect(lc.statusNow).toBe("stopped");
    await delay(50);
    expect(fake.state.wsClients).toBe(0);
  });
});

// ── e2e：真实入站回流 ──
describe("T2 e2e：bound 用户 + pending ask → 文本事件 → 判答收口 + 回复回发", () => {
  const stubJudge = (deps: RunDeps, log: { calls: number }): ConfiguredRunPiStream => async (call) => {
    log.calls++;
    const appends = (call as any).appendSystemPrompt ?? [];
    const askEl = appends.find((s: string) => s.startsWith("[待处理提问] 澄清"));
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

  test("push receive_v1 文本 → 回复经 send 回发到 open_id + 卡 answered + 消息进会话历史", async () => {
    const fake = fakeFeishuWs();
    const transport = new FeishuTransport({ appId: "cli_x", appSecret: "s_y", baseUrl: "https://fake.feishu", fetchFn: fakeFeishuFetch(fake.app) });
    const db = openDbMigrated(":memory:");
    const store = createStores(db);
    const userStore = new UserStore(db);
    const eventBus = new EventBus();
    const queues = new ConversationQueues();
    const log = { calls: 0 };
    const deps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore,
      streamRegistry: new StreamRegistry(),
      workspaceStore: new WorkspaceStore(db),
      taskStore: new ScheduledTaskStore(db, store.chat),
      eventBus, conversationQueues: queues, imStore: new ImStore(db),
      runLifecycle: new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubRunPiFactory }),
      runPiStreamFactory: () => stubJudge(deps, log),
    };
    const inbound = makeFeishuInbound(deps, transport);
    const lc = new FeishuLongConnection({
      appId: "cli_x", appSecret: "s_y", baseUrl: "https://fake.feishu",
      fetchFn: fakeFeishuFetch(fake.app), onEvent: (p) => { void inbound(p).catch(console.error); },
      pingIntervalMs: 40, log: () => {},
    });
    lc.start();
    await delayUntil(() => fake.state.wsClients === 1, 3000);

    // 场景：m1 绑 ou_1，会话 + 一张 pending ask 卡
    await userStore.createUser({ username: "m1", password: "pw-long-enough", role: "member" });
    const m1 = userStore.getUserByUsername("m1")!;
    store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    deps.imStore!.bind("ou_1", "feishu", m1.id);
    const qid = store.hitl.createQuestion({ conversationId: "c1", runId: null, prompt: "澄清：预算区间？", options: ["<10w", ">50w"] });

    await fake.pushEvent(receiveTextEvent("ou_1", "不超过 10 万"));
    await delayUntil(() => store.hitl.getQuestion(qid)!.status === "answered", 3000);

    expect(log.calls).toBeGreaterThan(0); // 起过一轮 chat turn
    expect(store.chat.listMessages("c1").some((m) => m.role === "user" && m.content === "不超过 10 万")).toBe(true); // 文本进历史
    expect(store.hitl.getQuestion(qid)!.status).toBe("answered");
    expect(fake.state.sent).toHaveLength(1); // 回复经 T1 send 回发
    expect(fake.state.sent[0].receiveId).toBe("ou_1");
    expect(String((fake.state.sent[0].content as any).text)).toContain("回答已记录");

    lc.stop(); fake.close();
  });

  test("未绑定用户文本事件 → 丢弃（ack 200、仅此一次 ack，不产出发送、不起轮）", async () => {
    const fake = fakeFeishuWs();
    const transport = new FeishuTransport({ appId: "cli_x", appSecret: "s_y", baseUrl: "https://fake.feishu", fetchFn: fakeFeishuFetch(fake.app) });
    const db = openDbMigrated(":memory:");
    const store = createStores(db);
    const userStore = new UserStore(db);
    const eventBus = new EventBus();
    const queues = new ConversationQueues();
    const log = { calls: 0 };
    const deps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore,
      streamRegistry: new StreamRegistry(),
      workspaceStore: new WorkspaceStore(db),
      taskStore: new ScheduledTaskStore(db, store.chat),
      eventBus, conversationQueues: queues, imStore: new ImStore(db),
      runLifecycle: new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus, runPiFactory: stubRunPiFactory }),
      runPiStreamFactory: () => stubJudge(deps, log),
    };
    const inbound = makeFeishuInbound(deps, transport);
    const lc = new FeishuLongConnection({
      appId: "cli_x", appSecret: "s_y", baseUrl: "https://fake.feishu",
      fetchFn: fakeFeishuFetch(fake.app), onEvent: (p) => { void inbound(p).catch(console.error); },
      pingIntervalMs: 40, log: () => {},
    });
    lc.start();
    await delayUntil(() => fake.state.wsClients === 1, 3000);

    const { ack } = await fake.pushEvent(receiveTextEvent("ou_nobody", "你好"));
    expect(ack.code).toBe(200); // 事件级 ack（协议层不因业务丢弃而失败）
    await delay(80);
    expect(log.calls).toBe(0); // 不起轮
    expect(fake.state.sent).toHaveLength(0); // 不产出发送
    expect(fake.state.acks).toHaveLength(1); // 只 ack 事件本身

    lc.stop(); fake.close();
  });
});