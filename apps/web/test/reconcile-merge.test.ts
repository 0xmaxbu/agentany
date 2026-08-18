// T5（#54）：断流对账纯函数——mergeById / reconcileMessages 幂等合并语义。
// seam：纯函数直测；store 装配的 reconcile 见 reconcile-store.test。
import { describe, test, expect } from "bun:test";
import { mergeById, reconcileMessages, type UIMessage } from "../src/store/chat";

const m = (id: number | null, role: "user" | "assistant" = "user", text = "x"): UIMessage => ({
  id, role, status: "complete", blocks: [{ kind: "text", text }],
});
const textOf = (msg: UIMessage) => (msg.blocks.find((b) => b.kind === "text") as { kind: "text"; text: string } | undefined)?.text;

describe("mergeById：按 key 幂等合并", () => {
  const key = (x: { id: number }) => x.id;

  test("重叠 → 同 key 被 incoming 覆盖、不重复", () => {
    const out = mergeById([{ id: 1 }, { id: 2 }], [{ id: 2, plus: true }, { id: 3 }], key);
    expect(out).toEqual([{ id: 1 }, { id: 2, plus: true }, { id: 3 }]);
  });

  test("incoming 为空 → 原样；incoming 全新 → 追加", () => {
    expect(mergeById([{ id: 1 }], [], key)).toEqual([{ id: 1 }]);
    expect(mergeById([{ id: 1 }], [{ id: 9 }], key)).toEqual([{ id: 1 }, { id: 9 }]);
  });

  test("快照没有但 live 有 → 保留（存量不删）", () => {
    expect(mergeById([{ id: 1 }, { id: 42 }], [{ id: 1 }], key)).toEqual([{ id: 1 }, { id: 42 }]);
  });
});

describe("reconcileMessages：消息幂等合并（id 幂等 + 未定稿让位 + 时间序）", () => {
  test("live 未定稿(id null)占位被快照权威版取代；同 id 覆盖；按 id 升序", () => {
    const live = [m(1), m(null, "assistant", "流式中占位"), m(2, "assistant", "旧版")];
    const snap = [m(2, "assistant", "正式版"), m(3)];
    const out = reconcileMessages(live, snap);
    expect(out.map((x) => x.id)).toEqual([1, 2, 3]); // 无占位 null、id 序
    expect(textOf(out.find((x) => x.id === 2)!)).toBe("正式版"); // 快照覆盖
    expect(out.some((x) => x.id === null)).toBe(false); // 未定稿占位丢弃
  });

  test("重复 reconcile（重连多次）→ 结果稳定不膨胀", () => {
    const live = [m(1)];
    const snap = [m(1), m(2)];
    const once = reconcileMessages(live, snap);
    const twice = reconcileMessages(once, snap);
    expect(twice).toEqual(once); // 幂等
    expect(twice).toHaveLength(2);
  });
});