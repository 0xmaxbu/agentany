// #34 消息级反馈锚对齐：pi 源历史（id=session entry id）↔ DB messages（id=自增）按 (role, content)
// 双指针对齐回填 DB id——消息级反馈/回显在刷新后仍可定位（票面验收「已给反馈回显」的必要条件）。
import { describe, test, expect } from "bun:test";
import { alignDbIds, type AlignHist } from "../src/chat/align-db-ids";

describe("alignDbIds（双源对齐回填）", () => {
  test("顺序对齐：user/assistant 交错，DB id 回填", () => {
    const hist = [
      { id: "entry-1", role: "user", content: "你好" },
      { id: "entry-2", role: "assistant", content: "你好，世界" },
      { id: "entry-3", role: "user", content: "谢谢" },
      { id: "entry-4", role: "assistant", content: "不客气" },
    ];
    const db = [
      { id: 101, role: "user", content: "你好" },
      { id: 102, role: "assistant", content: "你好，世界" },
      { id: 103, role: "user", content: "谢谢" },
      { id: 104, role: "assistant", content: "不客气" },
    ];
    const out = alignDbIds(hist as AlignHist[], db);
    expect(out.map((m) => m.dbId)).toEqual([101, 102, 103, 104]);
    expect(out[0].id).toBe("entry-1"); // 原字段不动（display/关联两用）
  });

  test("pi 源多出（DB 未落：error/aborted turn）→ 该条 dbId=null；后续仍对齐", () => {
    const hist = [
      { id: "e1", role: "user", content: "q1" },
      { id: "e2", role: "assistant", content: "a1" },
      { id: "e3", role: "user", content: "q2" },
      { id: "e4", role: "assistant", content: "a2" }, // DB 缺（aborted：runTurn 不落库）
    ];
    const db = [
      { id: 1, role: "user", content: "q1" },
      { id: 2, role: "assistant", content: "a1" },
      { id: 3, role: "user", content: "q2" },
    ];
    const out = alignDbIds(hist as AlignHist[], db);
    expect(out.map((m) => m.dbId)).toEqual([1, 2, 3, null]);
  });

  test("重复同文（定时任务同 prompt 多轮）→ 贪心顺序对齐不串位", () => {
    const hist = [
      { id: "e1", role: "user", content: "每4小时汇总" },
      { id: "e2", role: "assistant", content: "产出" },
      { id: "e3", role: "user", content: "每4小时汇总" },
      { id: "e4", role: "assistant", content: "产出" },
    ];
    const db = [
      { id: 11, role: "user", content: "每4小时汇总" },
      { id: 12, role: "assistant", content: "产出" },
      { id: 13, role: "user", content: "每4小时汇总" },
      { id: 14, role: "assistant", content: "产出" },
    ];
    const out = alignDbIds(hist as AlignHist[], db);
    expect(out.map((m) => m.dbId)).toEqual([11, 12, 13, 14]);
  });

  test("DB 空表 → 全 null（不炸）", () => {
    const out = alignDbIds([{ id: "e1", role: "user", content: "x" }], []);
    expect(out[0].dbId).toBeNull();
  });
});
