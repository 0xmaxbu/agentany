// E2E 专用 server 入口：用 createApp + DI 注 stub。
// 绕过真 pi / 沙箱 / API key / 网络 / LLM —— 确定性、零 token、可复现。
// 由 Playwright webServer 以 `DATA_DIR=<temp> PORT=<port> bun run apps/server/src/e2e-entry.ts` 启动。
//
// #19：补全栈（eventBus/runRegistry/bridge）—— chat stub 脚本化驱动【真桥接 + 真事件】全链
// （start→step→suspend→自动 turn→ask_user→判答 resume→completed→总结）。
import { createApp } from "./app";
import { openDbMigrated } from "./db/client";
import { WorkflowStore } from "./workflow-engine/store";
import { EventBus } from "./chat/eventbus";
import { RunRegistry } from "./runs/registry";
import { startBridge, BRIDGE_PORT } from "./bridge/server";
import { UserStore } from "./auth/store";
import { StreamRegistry } from "./chat/stream-registry";
import { WorkspaceStore } from "./workspaces/store";
import { ScheduledTaskStore } from "./scheduled-tasks/store";
import { TaskScheduler } from "./scheduled-tasks/scheduler";
import { makeExecuteTask } from "./scheduled-tasks/execute";
import { ConversationQueues } from "./chat/queue";
import type { RunDeps } from "./runs";
import type { ConfiguredRunPiStream, ConfiguredRunPi } from "./pi/runPi-factory";
import type { RunPiResult } from "./workflow-engine/defineWorkflow";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// slice① 默认 token 序列（markdown）—— 非 workflow 场景的确定性回复。
const TOKENS = ["# ", "你好", "，世界", "\n\n**", "测试", "**", "\n\n`", "code", "`"];

// f3/ADR-0019：stub 全量改发 block 三帧（text block 流式 = start→逐 token delta→end）。
// legacy onDelta 已删——e2e 文本断言经 block 流落进 .bubble.assistant，DOM 契约不变。
const streamText = async (call: { onBlock?: (b: import("./blocks").StreamBlock) => void }, full: string, tokens: string[]) => {
  const id = `b_${full.length}_${full.slice(0, 8)}`;
  call.onBlock?.({ op: "start", blockId: id, kind: "text" });
  for (const t of tokens) {
    call.onBlock?.({ op: "delta", blockId: id, delta: t });
    await delay(150); // 逐 token 节奏（chat.spec 增量断言「中间态 < 终态」依赖）
  }
  call.onBlock?.({ op: "end", blockId: id });
};
// 一次性完整文本（无流式必要——workflow 文案不在增量断言路径）
const emitText = (call: { onBlock?: (b: import("./blocks").StreamBlock) => void }, text: string) => {
  const id = `b_${text.length}`;
  call.onBlock?.({ op: "start", blockId: id, kind: "text" });
  call.onBlock?.({ op: "delta", blockId: id, delta: text });
  call.onBlock?.({ op: "end", blockId: id });
};

// run 用 stub factory（synthetic 纯程序步不调 runPi；兜底，正常永不被调）。
const stubRunPiFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });

// chat 用 scripted stub factory：按 prompt/#17 注入段分支，fetch 真 bridge 驱动全链。
// runId 多源正则（事件 prompt `(r_xxx)` / [挂起工作流] run r_xxx / [待处理提问] 工作流 r_xxx）。
const runIdFrom = (s: string): string | null => {
  const m = s.match(/r_[A-Za-z0-9-]+/);
  return m ? m[0] : null;
};
const scriptedStubFactory = (): ConfiguredRunPiStream => async (call): Promise<RunPiResult> => {
  if (call.prompt.toLowerCase().includes("error")) throw new Error("stub: 模拟失败");
  const bridge = call.bridge; // {port, nonce, url}（turn.ts 注入）
  const append = (call.appendSystemPrompt ?? []).join("\n");
  const post = async (path: string, body: unknown): Promise<any> => {
    if (!bridge) return null;
    const r = await fetch(`${bridge.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.nonce}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json().catch(() => null);
  };

  // 顺序敏感：先系统事件 turn（prompt 含事件标志），再用户 turn。
  // f3 blocks.spec：完整四件套序列（thinking→tool_use→tool_result→text）驱动前端块渲染断言。
  if (call.prompt.includes("看过程")) {
    const b = call.onBlock ?? (() => {});
    b({ op: "start", blockId: "k1", kind: "thinking" });
    b({ op: "delta", blockId: "k1", delta: "先看文件再回答" });
    b({ op: "end", blockId: "k1" });
    b({ op: "start", blockId: "t1", kind: "tool_use", meta: { toolCallId: "t1", name: "read", arguments: { path: "src/app.ts" } } });
    b({ op: "end", blockId: "t1" });
    b({ op: "start", blockId: "r_t1", kind: "tool_result", meta: { toolCallId: "t1", toolName: "read", isError: false } });
    b({ op: "delta", blockId: "r_t1", delta: "export const A = 1;" });
    b({ op: "end", blockId: "r_t1" });
    emitText(call, "看完了，一切正常。");
    return { text: "看完了，一切正常。", messages: [], toolResults: [] };
  }
  if (call.prompt.includes("挂起待决策")) {
    // run_suspended 事件 turn → 建提问卡（ask_user）
    const runId = runIdFrom(call.prompt) ?? runIdFrom(append);
    emitText(call, "工作流挂起，需要你决策。");
    if (runId) await post("/ask_user", { runId, prompt: "选哪个？", options: ["accept", "redirect"] });
    return { text: "工作流挂起，需要你决策。", messages: [], toolResults: [] };
  }
  if (call.prompt.includes("已完成")) {
    emitText(call, "工作流已完成，这是总结。");
    return { text: "工作流已完成，这是总结。", messages: [], toolResults: [] };
  }
  if (call.prompt.includes("失败")) {
    emitText(call, "工作流失败，已告知用户。");
    return { text: "工作流失败，已告知用户。", messages: [], toolResults: [] };
  }
  // 用户 turn：回答待处理提问 → resume。用元素前缀过滤（CHAT_SYSTEM_PROMPT 含「[待处理提问]」指引文本，
  // 故不能用 append.includes——会恒真。注入段前缀「[待处理提问] 工作流」与指引文本可区分）。
  const pendingAskEl = (call.appendSystemPrompt ?? []).find((s) => s.startsWith("[待处理提问] 工作流"));
  if (pendingAskEl) {
    const runId = runIdFrom(pendingAskEl);
    emitText(call, "好的，按你的选择续跑。");
    if (runId) await post("/run/resume", { runId, resumeData: { decision: "accept" } });
    return { text: "好的，按你的选择续跑。", messages: [], toolResults: [] };
  }
  // ADR-0022 统一卡应答：点 accept = 发消息（"accept"）+ inReplyTo——服务端已确定性 resume（dispatch 内），
  // 本 turn 只是普通对话轮（挂起注入已被 markPendingAnsweredByRun 收走）→ 短确认即可。
  if (call.prompt.trim() === "accept" || call.prompt.trim() === "redirect") {
    emitText(call, "收到，已按你的选择处理。");
    return { text: "收到，已按你的选择处理。", messages: [], toolResults: [] };
  }
  if (call.prompt.includes("合成") || call.prompt.includes("跑")) {
    // 用户要求跑工作流 → start_workflow（synthetic=allow 直跑）
    emitText(call, "好的，启动合成三步工作流。");
    await post("/run/start", { workflowId: "synthetic-3step", input: {} });
    return { text: "好的，启动合成三步工作流。", messages: [], toolResults: [] };
  }
  // #命名：一次性命名调用（独立 title- session）→ 回用户消息前 16 字（≥8 字下限；e2e 里标题即唯一定位锚）
  if (call.prompt.includes("提取主题")) {
    const src = call.prompt.split("用户提问：")[1] ?? "自动生成的会话标题";
    const title = src.slice(0, 16).trim() || "自动生成的会话标题";
    emitText(call, title);
    return { text: title, messages: [], toolResults: [] };
  }
  // default：slice① TOKENS（保 chat/history/markdown spec 绿）
  await streamText(call, TOKENS.join(""), TOKENS);
  return { text: TOKENS.join(""), messages: [], toolResults: [] };
};

const db = openDbMigrated();
// f2：seed dev 用户行并把 AGENTANY_DEV_USER 指到其 id——前端 bootstrap 调 GET /me 需真返 200
// （dev 阀放行 identity 默认 id="dev-user"，users 表无此行则 /me 404 → 前端误判未登录挡住 e2e）。
{
  const us = new UserStore(db);
  const existing = us.getUserByUsername("dev-user");
  const u = existing ?? (await us.createUser({ username: "dev-user", password: "e2e-no-login", displayName: "E2E Dev" }));
  process.env.AGENTANY_DEV_USER = u.id; // middleware 每请求读 env——identity 对齐 seed 行
  // f4 e2e：member 账号（管理页无权限段用——dev-user 是 admin 角色走不了 403 路径）
  if (!us.getUserByUsername("member-e2e")) await us.createUser({ username: "member-e2e", password: "member-e2e-pw-1", displayName: "E2E Member", role: "member" });
}
const store = new WorkflowStore(db);
const eventBus = new EventBus(); // 【硬条件·#19】共享：bridge run 事件 → TurnTrigger 自动 turn（不传则全链断）
const runRegistry = new RunRegistry({ store, eventBus, runPiFactory: stubRunPiFactory });
// #31：定时任务三表 + 调度器（手动跑走真 executeTask——runTurn 用下面的 stub streamFactory 产出确定性文本）
const taskStore = new ScheduledTaskStore(db, store);
const deps: RunDeps = {
  store,
  userStore: new UserStore(db),
  streamRegistry: new StreamRegistry(),
  workspaceStore: new WorkspaceStore(db),
  eventBus,
  runRegistry,
  runPiStreamFactory: scriptedStubFactory,
  taskStore,
  conversationQueues: new ConversationQueues(),
};
deps.scheduler = new TaskScheduler({
  store: taskStore,
  executeTask: makeExecuteTask({ deps, queues: deps.conversationQueues!, eventBus }),
});
// auth/鉴权依赖（e2e 走 dev 放行；workspaceStore 公司 ws 由迁移 seed）
const app = createApp(deps);
startBridge(BRIDGE_PORT, { runRegistry, store, eventBus }); // bridge RPC（loopback:3199，stub 经此驱动）

const port = Number(process.env.PORT ?? 3000);
Bun.serve({ port, hostname: "127.0.0.1", fetch: (r) => app.fetch(r) });
console.log(`e2e server on http://127.0.0.1:${port}`);
