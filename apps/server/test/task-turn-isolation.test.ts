// review-c1/c4（M4 双轴审查）：产出会话不被 executeTask 的 user_message 帧双起 turn；
// 任务 turn 不发 bridge nonce / 不放行 loopback（任务 pi 无交互通道）。
// seam：直构 makeExecuteTask + 真路由 POST /messages（attach TurnTrigger）+ 计数 stub。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { makeExecuteTask } from "../src/scheduled-tasks/execute";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPiStream } from "../src/pi/runPi-factory";

const JH = { "content-type": "application/json" };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) { if (pred()) return; await delay(10); }
};

/** 计数 stub：记录每次调用的 bridge 参数（c1 断言 prompt 不重复跑、c4 断言无 bridge）。 */
function countingStub() {
  const calls: Array<{ prompt: string; bridge?: unknown; appendSystemPrompt?: string[] }> = [];
  const factory = (): ConfiguredRunPiStream => {
    return async (call: any) => {
      calls.push({ prompt: call.prompt, bridge: call.bridge, appendSystemPrompt: call.appendSystemPrompt });
      return { text: "产出", messages: [], toolResults: [] };
    };
  };
  return { factory: factory as any, calls };
}

async function setup() {
  const stub = countingStub();
  const db = openDbMigrated(":memory:");
  const store = createStores(db);
  const userStore = new UserStore(db);
  await userStore.createUser({ username: "m1", password: "pw-long-enough", role: "member" });
  const m1 = userStore.getUserByUsername("m1")!;
  const queues = new ConversationQueues();
  const deps: RunDeps = {
    runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore, streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store.chat),
    eventBus: new EventBus(),
    runPiStreamFactory: stub.factory,
    conversationQueues: queues,
  };
  const app = createApp(deps);
  const login = async () => {
    const r = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: "m1", password: "pw-long-enough" }) });
    return `Bearer ${(await r.json() as any).token}`;
  };
  return { deps, store, userStore, app, m1, stub, queues, login };
}

describe("review-c1：产出会话不双跑（user_message 帧带 taskId，TurnTrigger 跳过）", () => {
  test("用户先在产出会话发过消息（attach 成立）→ 到点执行 → 同一 prompt 只跑一次（无第二条 HTTP turn）", async () => {
    const ctx = await setup();
    const task = ctx.deps.taskStore!.createWorkspaceTask({
      displayName: "T", cron: "0 */4 * * *", prompt: "任务目标原文",
      workspaceId: "ws_company", creatorId: ctx.m1.id, firstFireAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    // 用户点进产出会话回一句话 → POST /messages → turnTrigger.attach（幂等兜底路径）
    const tok = await ctx.login();
    const posted = await ctx.app.request(`/conversations/${task.outputConversationId}/messages`, {
      method: "POST", headers: { ...JH, authorization: tok }, body: JSON.stringify({ content: "用户插一句" }),
    });
    expect(posted.status).toBe(202);
    await until(() => ctx.stub.calls.length >= 1); // route 202 不等待——poll stub 已记录 attach turn 调用
    await delay(40); // 使其跑完 + 可能的 title 副调用（确定性 stub 快）；makeExecuteTask 内部 await whenDone 完备后续
    ctx.stub.calls.length = 0; // 清零——只数任务执行的 turn

    // 到点执行（executeTask publish user_message 帧——修复前会经 TurnTrigger 双起一条 HTTP turn）
    await makeExecuteTask({ deps: ctx.deps, queues: ctx.queues, eventBus: ctx.deps.eventBus! })(task, "cron");
    await new Promise((r) => setTimeout(r, 30));

    // 同一任务 prompt 只跑一次（双跑 = calls 里两条同 prompt 或 CHAT_SYSTEM_PROMPT 混入）
    const taskTurns = ctx.stub.calls.filter((c) => c.prompt === "任务目标原文");
    expect(taskTurns).toHaveLength(1);
    // 双起的那条走 CHAT_SYSTEM_PROMPT（含 chat 工具清单）——修复后不应存在
    expect(ctx.stub.calls.some((c) => (c.appendSystemPrompt ?? []).some((s) => s.includes("对话助手")))).toBe(false);
  });
});

describe("review-c4：任务 turn 无 bridge（nonce 不发、loopback 不放行）", () => {
  test("executeTask 的任务 turn：runPi 调用不带 bridge 通道（chat turn 仍带）", async () => {
    const ctx = await setup();
    const task = ctx.deps.taskStore!.createWorkspaceTask({
      displayName: "T", cron: "0 */4 * * *", prompt: "无桥任务",
      workspaceId: "ws_company", creatorId: ctx.m1.id, firstFireAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await makeExecuteTask({ deps: ctx.deps, queues: ctx.queues, eventBus: ctx.deps.eventBus! })(task, "cron");
    await new Promise((r) => setTimeout(r, 20));

    const taskTurns = ctx.stub.calls.filter((c) => c.prompt === "无桥任务");
    expect(taskTurns).toHaveLength(1);
    expect(taskTurns[0].bridge).toBeUndefined(); // 无 nonce/url——任务 pi 无交互通道
  });
});
