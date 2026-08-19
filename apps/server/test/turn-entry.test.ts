// ADR-0029 起轮入口验收：startUserTurn/startSystemTurn + whenDone/busy/appended_only/skipTurn。
// seam：stub stream（计数 factory：created=makeRunPiStream opts[extensions]，calls=每轮 call[bridge/appendSystemPrompt]）
// + 真 ConversationQueues（busy 序）或 stub queues（appended_only）。
import { describe, test, expect } from "bun:test";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { createStores, type Stores } from "../src/stores";
import { openDbMigrated } from "../src/db/client";
import { fullDeps } from "./deps";
import { startUserTurn, startSystemTurn, type TurnEntryResult } from "../src/chat/turn-entry";
import type { RunDeps } from "../src/runs";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface StubRec {
  created: Array<{ extensions?: string[] }>;
  calls: Array<{ prompt: string; bridge?: unknown; appendSystemPrompt?: string[] }>;
  stream: (call: any) => Promise<{ text: string; messages: unknown[]; toolResults: unknown[] }>;
  factory: unknown;
}

function makeStub(throwOn?: string): StubRec {
  const created: Array<{ extensions?: string[] }> = [];
  const calls: Array<{ prompt: string; bridge?: unknown; appendSystemPrompt?: string[] }> = [];
  const factory = (opts: any) => {
    created.push(opts);
    return async (call: any) => {
      if (throwOn && call.prompt === throwOn) throw new Error("boom");
      calls.push({ prompt: call.prompt, bridge: call.bridge, appendSystemPrompt: call.appendSystemPrompt });
      call.onBlock?.({ op: "start", blockId: "b1", kind: "text" });
      call.onBlock?.({ op: "delta", blockId: "b1", delta: "PONG" });
      call.onBlock?.({ op: "end", blockId: "b1" });
      return { text: "PONG", messages: [], toolResults: [] };
    };
  };
  return { created, calls, stream: undefined as never, factory };
}

function makeHarness(throwOn?: string) {
  const st = makeStub(throwOn);
  const store = createStores(openDbMigrated(":memory:"));
  store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u1" });
  const deps: RunDeps = fullDeps(store, {
    runPiStreamFactory: st.factory as never,
    listWorkflows: () => [], // ADR-0029：注入免触全局 registry 态
  });
  const bus = new EventBus();
  const queues = new ConversationQueues();
  const frames: any[] = [];
  bus.subscribe("c1", (f) => frames.push(f));
  const entry = { deps, queues, publish: (f: any) => bus.publish("c1", f) };
  return { st, store, deps, bus, queues, frames, entry };
}

describe("startUserTurn — ADR-0029 入口三态 + whenDone", () => {
  test("accepted → whenDone done{messageId} + 用户/助手消息落库 + 帧全量发布", async () => {
    const { entry, store, frames, st } = makeHarness();
    const r = startUserTurn(entry, "c1", "hello", {});
    expect(r.status).toBe("accepted");
    const out = await (r as { status: "accepted"; whenDone: Promise<any> }).whenDone;
    expect(out.status).toBe("done");
    expect(store.chat.listMessages("c1").find((m) => m.role === "user")?.content).toBe("hello");
    expect(store.chat.listMessages("c1").find((m) => m.id === out.messageId && m.role === "assistant")?.content).toBe("PONG");
    expect(frames.some((f) => f.type === "user_message" && f.content === "hello")).toBe(true);
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(st.calls[0]?.bridge).toBeDefined(); // user flavor 缺省带 bridge（nonce+url）
    expect((st.calls[0]?.appendSystemPrompt ?? []).some((s) => s.includes("对话助手"))).toBe(true); // CHAT_SYSTEM_PROMPT 注入
  });

  test("busy 预检在写入前：队列满 → busy、零落库、零 user_message 帧", async () => {
    const { entry, store, frames, queues } = makeHarness();
    for (let i = 0; i < 5; i++) queues.enqueueHttpTurn("c1", () => new Promise<void>(() => {})); // 灌满 cap
    const r = startUserTurn(entry, "c1", "hi", {});
    expect(r.status).toBe("busy");
    expect(store.chat.listMessages("c1")).toHaveLength(0); // 未落库
    expect(frames.some((f) => f.type === "user_message")).toBe(false); // 未发布
  });

  test("skipTurn 绕过队列：满队 + skipTurn → accepted、消息落、帧 cardAnswered、无 whenDone", async () => {
    const { entry, store, frames, queues } = makeHarness();
    for (let i = 0; i < 5; i++) queues.enqueueHttpTurn("c1", () => new Promise<void>(() => {}));
    const r = startUserTurn(entry, "c1", "accept", { skipTurn: true });
    expect(r.status).toBe("accepted");
    expect(store.chat.listMessages("c1")).toHaveLength(1); // 程序化收口轮照常落库
    const um = frames.find((f) => f.type === "user_message");
    expect(um?.cardAnswered).toBe(true); // 前端免 LLM 占位旗标
    expect((r as { whenDone?: Promise<unknown> }).whenDone).toBeUndefined(); // 确定性收口无 LLM whenDone
  });

  test("appended_only（入队竞态拒）：消息已落 + error 帧已发", async () => {
    const { store, frames, deps } = makeHarness();
    const fakeQueues = {
      wouldAcceptHttpTurn: () => true, // 预检过
      enqueueHttpTurn: () => false, // 但入队竞态拒
      enqueueEventTurn: () => false,
    } as unknown as ConversationQueues;
    const bus = new EventBus();
    const frames2: any[] = [];
    bus.subscribe("c1", (f) => frames2.push(f));
    const r = startUserTurn({ deps, queues: fakeQueues, publish: (f: any) => bus.publish("c1", f) }, "c1", "hi", {});
    expect(r.status).toBe("appended_only");
    expect(store.chat.listMessages("c1")).toHaveLength(1);
    expect(frames2.some((f) => f.type === "error" && f.message.includes("busy"))).toBe(true);
  });

  test("error 路径 → whenDone error（runPi 抛错）", async () => {
    const { entry, frames } = makeHarness("boom");
    const r = startUserTurn(entry, "c1", "boom", {}) as { status: "accepted"; whenDone: Promise<any> };
    const out = await r.whenDone;
    expect(out.status).toBe("error");
    expect(out.error).toContain("boom");
    expect(frames.some((f) => f.type === "error")).toBe(true); // SSE 收 error 帧（调用方自行决定 IM 回执姿态）
  });
});

describe("startSystemTurn — ADR-0029 系统消息（定时任务交付）", () => {
  test("extensions/appendSystemPrompt 透传进 runTurn + noBridge + user_message 帧带 taskId", async () => {
    const { entry, frames, st } = makeHarness();
    const r = startSystemTurn(entry, "c1", "任务目标", {
      taskId: "t1",
      extensions: ["ext/tavily"],
      appendSystemPrompt: ["TASK_MEMO"],
    }) as { status: "accepted"; whenDone: Promise<any> };
    const out = await r.whenDone;
    expect(out.status).toBe("done");
    expect(st.created[0]?.extensions).toEqual(["ext/tavily"]); // extensions 经 makeRunPiStream opts
    expect(st.calls[0]?.appendSystemPrompt).toContain("TASK_MEMO");
    expect(st.calls[0]?.bridge).toBeUndefined(); // system flavor noBridge（无人值守无交互通道）
    expect(frames.find((f: any) => f.type === "user_message")?.taskId).toBe("t1"); // 任务归属帧
  });
});