// T5（#54）：openStream 断流自动重连——runStreamLoop 状态机（有界退避 + onReconnect + abort 停）。
// seam：依赖注入 connect（无真网络）。openStream 本体 = runStreamLoop + fetch/reader 薄胶水。
import { describe, test, expect } from "bun:test";
import { runStreamLoop } from "../src/api";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(5); }
};

describe("runStreamLoop（断流自动重连）", () => {
  test("掉线 → 退避重连（onReconnect 仅掉线后触发，首次连接不调）", async () => {
    const ac = new AbortController();
    const connects: number[] = [];
    const reconnects: number[] = [];
    const p = runStreamLoop(async () => {
      connects.push(connects.length + 1);
      if (connects.length === 1) return; // 第一次连接立即掉线
      await new Promise<void>((r) => ac.signal.addEventListener("abort", () => r(), { once: true })); // 第二次挂住健康的
    }, ac.signal, { backoffMs: () => 1, healthyMs: 1000, onReconnect: () => reconnects.push(1) });
    await delayUntil(() => connects.length === 2); // 已进入第二次连接
    expect(reconnects).toHaveLength(1); // 仅一次掉线 → 一次重连对账
    ac.abort();
    await p;
    expect(connects).toHaveLength(2); // abort 后不再发起
  });

  test("断流风暴：退避让渡事件循环、次数有界增长（abort 即停，不忙等）", async () => {
    const ac = new AbortController();
    let connects = 0;
    const t0 = Date.now();
    const p = runStreamLoop(async () => { connects++; }, ac.signal, {
      backoffMs: (a) => Math.min(3 * a, 12), // 短有界退避（测试）
      healthyMs: 1_000_000, // 永不复位：attempt 单调增长验证封顶
    });
    await delayUntil(() => connects >= 5);
    ac.abort();
    await p;
    expect(connects).toBeGreaterThanOrEqual(5);
    expect(Date.now() - t0).toBeLessThan(300); // 反复断连间有退避让渡（非忙自旋吃满事件循环）
  });

  test("connect 抛错（网络错误）同样走退避重连", async () => {
    const ac = new AbortController();
    let n = 0;
    const p = runStreamLoop(async () => {
      n++;
      throw new Error("fetch failed"); // 第一次抛错
    }, ac.signal, { backoffMs: () => 1, healthyMs: 5 });
    await delayUntil(() => n >= 3); // 错误 → 退避 → 重试
    ac.abort();
    await p;
    expect(n).toBeGreaterThanOrEqual(3);
  });
});