// Soul.md（chat 助手全局沟通契约，ADR-0024）：机制测试。
// 全 stub（runPiStreamFactory 捕获 appendSystemPrompt）——不碰真 LLM：
// ① loadSoul 读写 ② 用户 turn 注入（紧随 CHAT_SYSTEM_PROMPT）③ 任务 turn（显式 opts.appendSystemPrompt）不带 Soul。
// run 边界事件在 main 上已是零 LLM 简报/强制卡（ADR-0025 决策 1/5）——不产生 LLM turn，故无事件注入用例；
// 单一注入点 runTurn 覆盖所有剩余 LLM turn（用户消息 / IM 回流 / 待处理提问判答，turn-inline 等均经 runTurn）。
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/chat/turn";
import { WorkflowStore } from "../src/workflow-engine/store";
import { openDbMigrated } from "../src/db/client";
import { loadSoul } from "../src/chat/soul";
import { fullDeps } from "./deps";
import type { ConfiguredRunPiStream } from "../src/pi/runPi-factory";

/** 捕获 appendSystemPrompt 的 stub（仿 turn-inline.test.ts / task-turn-isolation.test.ts）。 */
function captureFactory() {
  let captured: string[] | undefined;
  const factory = (): ConfiguredRunPiStream => async (call: any) => {
    captured = call.appendSystemPrompt;
    call.onBlock?.({ op: "start", blockId: "b1", kind: "text" });
    call.onBlock?.({ op: "delta", blockId: "b1", delta: "x" });
    call.onBlock?.({ op: "end", blockId: "b1" });
    return { text: "x", messages: [], toolResults: [] };
  };
  return { factory, append: () => captured };
}

describe("soul · loadSoul（ADR-0024）", () => {
  test("仓库根 Soul.md 存在且非空（契约文件被误删时此处先红）", () => {
    expect(loadSoul()).toBeTruthy();
    expect(loadSoul()!.trim().length).toBeGreaterThan(0);
  });

  test("自定义路径：存在→返内容；缺失→null（省略段，不炸 chat）", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-"));
    try {
      const p = join(dir, "Soul.md");
      writeFileSync(p, "# 契约", "utf-8");
      expect(loadSoul(p)).toBe("# 契约");
      expect(loadSoul(join(dir, "nope.md"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("soul · chat turn 注入（单一注入点 turn.ts）", () => {
  test("用户 turn（runTurn 直驱）：appendSystemPrompt[1] = Soul.md 全文，紧随 CHAT_SYSTEM_PROMPT", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u", title: "t" });
    const cap = captureFactory();
    const deps = fullDeps(store, { runPiStreamFactory: cap.factory });
    await runTurn(deps, "c1", "hi", () => {}, new AbortController().signal);
    const soul = loadSoul()!;
    expect(cap.append()).toBeDefined();
    expect(cap.append()![0]).toContain("对话助手"); // CHAT_SYSTEM_PROMPT 仍在前
    expect(cap.append()![1]).toBe(soul); // Soul 全文第二段
  });

  test("任务 turn（显式 opts.appendSystemPrompt）：不掺 Soul（headless 范围外）", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u", title: "t" });
    const cap = captureFactory();
    const deps = fullDeps(store, { runPiStreamFactory: cap.factory });
    await runTurn(deps, "c1", "任务目标", () => {}, new AbortController().signal, {
      appendSystemPrompt: ["任务系统提示（无人值守）"], noBridge: true,
    });
    expect(cap.append()).toEqual(["任务系统提示（无人值守）"]); // 原样，无 Soul
  });
});