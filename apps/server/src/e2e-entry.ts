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
import type { ConfiguredRunPiStream, ConfiguredRunPi } from "./pi/runPi-factory";
import type { RunPiResult } from "./workflow-engine/defineWorkflow";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// slice① 默认 token 序列（markdown）—— 非 workflow 场景的确定性回复。
const TOKENS = ["# ", "你好", "，世界", "\n\n**", "测试", "**", "\n\n`", "code", "`"];

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
  if (call.prompt.includes("挂起待决策")) {
    // run_suspended 事件 turn → 建提问卡（ask_user）
    const runId = runIdFrom(call.prompt) ?? runIdFrom(append);
    call.onDelta("工作流挂起，需要你决策。");
    if (runId) await post("/ask_user", { runId, prompt: "选哪个？", options: ["accept", "redirect"] });
    return { text: "工作流挂起，需要你决策。", messages: [], toolResults: [] };
  }
  if (call.prompt.includes("已完成")) {
    call.onDelta("工作流已完成，这是总结。");
    return { text: "工作流已完成，这是总结。", messages: [], toolResults: [] };
  }
  if (call.prompt.includes("失败")) {
    call.onDelta("工作流失败，已告知用户。");
    return { text: "工作流失败，已告知用户。", messages: [], toolResults: [] };
  }
  // 用户 turn：回答待处理提问 → resume。用元素前缀过滤（CHAT_SYSTEM_PROMPT 含「[待处理提问]」指引文本，
  // 故不能用 append.includes——会恒真。注入段前缀「[待处理提问] 工作流」与指引文本可区分）。
  const pendingAskEl = (call.appendSystemPrompt ?? []).find((s) => s.startsWith("[待处理提问] 工作流"));
  if (pendingAskEl) {
    const runId = runIdFrom(pendingAskEl);
    call.onDelta("好的，按你的选择续跑。");
    if (runId) await post("/run/resume", { runId, resumeData: { decision: "accept" } });
    return { text: "好的，按你的选择续跑。", messages: [], toolResults: [] };
  }
  if (call.prompt.includes("合成") || call.prompt.includes("跑")) {
    // 用户要求跑工作流 → start_workflow（synthetic=allow 直跑）
    call.onDelta("好的，启动合成三步工作流。");
    await post("/run/start", { workflowId: "synthetic-3step", input: {} });
    return { text: "好的，启动合成三步工作流。", messages: [], toolResults: [] };
  }
  // default：slice① TOKENS（保 chat/history/markdown spec 绿）
  for (const t of TOKENS) { call.onDelta(t); await delay(150); }
  return { text: TOKENS.join(""), messages: [], toolResults: [] };
};

const db = openDbMigrated();
const store = new WorkflowStore(db);
const eventBus = new EventBus(); // 【硬条件·#19】共享：bridge run 事件 → TurnTrigger 自动 turn（不传则全链断）
const runRegistry = new RunRegistry({ store, eventBus, runPiFactory: stubRunPiFactory });
// auth/鉴权依赖（e2e 走 dev 放行；workspaceStore 公司 ws 由迁移 seed）
const app = createApp({
  store,
  userStore: new UserStore(db),
  streamRegistry: new StreamRegistry(),
  workspaceStore: new WorkspaceStore(db),
  eventBus,
  runRegistry,
  runPiStreamFactory: scriptedStubFactory,
});
startBridge(BRIDGE_PORT, { runRegistry, store, eventBus }); // bridge RPC（loopback:3199，stub 经此驱动）

const port = Number(process.env.PORT ?? 3000);
Bun.serve({ port, hostname: "127.0.0.1", fetch: (r) => app.fetch(r) });
console.log(`e2e server on http://127.0.0.1:${port}`);
