// ticket #13：EventBus（per-conv pub/sub）+ ConversationQueues（两类入队、共享 FIFO、abort）单元测试。
import { describe, test, expect } from "bun:test";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("EventBus", () => {
  test("publish → 订阅者收帧；多订阅者都收", () => {
    const bus = new EventBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    bus.subscribe("c1", (f) => a.push(f));
    bus.subscribe("c1", (f) => b.push(f));
    bus.publish("c1", { type: "delta", text: "1" });
    expect(a).toEqual([{ type: "delta", text: "1" }]);
    expect(b).toEqual([{ type: "delta", text: "1" }]);
  });

  test("取消订阅后不再收", () => {
    const bus = new EventBus();
    const a: unknown[] = [];
    const unsub = bus.subscribe("c1", (f) => a.push(f));
    unsub();
    bus.publish("c1", { type: "delta", text: "x" });
    expect(a).toEqual([]);
  });

  test("per-conversation 隔离；无订阅者发布不抛", () => {
    const bus = new EventBus();
    const a: unknown[] = [];
    bus.subscribe("c1", (f) => a.push(f));
    bus.publish("c2", { type: "delta", text: "x" }); // 别的会话
    expect(a).toEqual([]);
    expect(() => bus.publish("nope", { type: "delta", text: "x" })).not.toThrow(); // 无订阅者
  });
});

describe("ConversationQueues · 两类入队 + 共享 FIFO", () => {
  test("enqueueHttpTurn 满（>MAX 5）→ false（429）", async () => {
    const q = new ConversationQueues();
    const slow = async () => {
      await delay(10);
    };
    const ok: boolean[] = [];
    for (let i = 0; i < 5; i++) ok.push(q.enqueueHttpTurn("c", slow));
    expect(ok.every(Boolean)).toBe(true);
    expect(q.enqueueHttpTurn("c", slow)).toBe(false); // 第 6 个 → 429
    await delay(80); // 让串行的 5 个跑完
  });

  test("enqueueEventTurn 不走 429、超 cap（>3）→ false（防风暴）", async () => {
    const q = new ConversationQueues();
    const slow = async () => {
      await delay(10);
    };
    expect(q.enqueueEventTurn("c", slow)).toBe(true);
    expect(q.enqueueEventTurn("c", slow)).toBe(true);
    expect(q.enqueueEventTurn("c", slow)).toBe(true);
    expect(q.enqueueEventTurn("c", slow)).toBe(false); // 第 4 个超 cap
    await delay(80);
  });

  test("HTTP + 事件 turn 共享同 FIFO → 严格串行（maxActive===1）", async () => {
    const q = new ConversationQueues();
    let active = 0;
    let max = 0;
    const mk = () => async () => {
      active++;
      max = Math.max(max, active);
      await delay(15);
      active--;
    };
    q.enqueueHttpTurn("c", mk());
    q.enqueueEventTurn("c", mk());
    q.enqueueHttpTurn("c", mk());
    await delay(100);
    expect(max).toBe(1); // 三类交错仍串行（pi session 不并发）
  });

  test("abort 杀当前在跑 turn（无论来源）", async () => {
    const q = new ConversationQueues();
    let aborted = false;
    q.enqueueHttpTurn("c", async (signal) => {
      return new Promise<void>((res) => {
        const t = setTimeout(res, 30000);
        signal.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(t);
          res();
        });
      });
    });
    await delay(10); // 让 turn 起来
    expect(q.abort("c")).toBe(true);
    await delay(20); // 等 chain finally 清 active（run 的 promise 在微任务里 resolve）
    expect(q.abort("c")).toBe(false); // 已杀，无在跑
    expect(aborted).toBe(true);
  });
});
