import { createApp } from "./app";
import { openDbMigrated } from "./db/client";
import { WorkflowStore } from "./workflow-engine/store";
import { EventBus } from "./chat/eventbus";
import { RunRegistry } from "./runs/registry";
import { UserStore } from "./auth/store";
import { StreamRegistry } from "./chat/stream-registry";
import { WorkspaceStore } from "./workspaces/store";
import { ScheduledTaskStore } from "./scheduled-tasks/store";
import { TaskScheduler } from "./scheduled-tasks/scheduler";
import { makeExecuteTask } from "./scheduled-tasks/execute";
import { ConversationQueues } from "./chat/queue";
import { bootstrapAdmin } from "./auth/bootstrap";
import { ensureKnowledgeRepo } from "./knowledge/repo";
import { PORT, FEISHU_APP_ID, FEISHU_APP_SECRET } from "./config";
import { warnIfNoSandbox } from "./pi/sandbox";
import { startBridge, BRIDGE_PORT } from "./bridge/server";
import { ImStore } from "./im/store";
import { FeishuTransport } from "./im/feishu/transport";
import { FeishuLongConnection } from "./im/feishu/long-connection";
import { makeFeishuInbound } from "./im/feishu/inbound";
import { handleCardAction } from "./im/feishu/card-action";
import { makePendingTextCache } from "./im/pending-text";
import { ImOutboundRouter } from "./im/outbound-router";
import type { RunDeps } from "./runs";

const db = openDbMigrated(); // 启动跑迁移（data/db.sqlite）
ensureKnowledgeRepo(); // #35：knowledge repo 就位（空则 init+布局+skills 种子；已有则 no-op）
const store = new WorkflowStore(db);
const userStore = new UserStore(db); // 真 auth（ADR-0014）：与 store 共享同一 db
const streamRegistry = new StreamRegistry(); // 活跃 SSE 登记：token 吊销时强断
const workspaceStore = new WorkspaceStore(db); // 工作空间 + 名单（ADR-0018）：与 store/userStore 共享同一 db；公司 ws 由迁移 seed
const taskStore = new ScheduledTaskStore(db, store); // 定时任务三表（#25/ADR-0021）：共享 db；产出会话复用 store.createConversation
taskStore.reviveSeedNextFire(); // seed nextFireAt=epoch 占位 → 启动算真值（enabled=0 保持禁用，M5 装配时启用）
const sweptRuns = taskStore.sweepUnfinishedRuns(); // 重启：执行中崩溃残留的 task_runs 收 failed（DB 真相）
if (sweptRuns > 0) console.log(`[scheduler] swept ${sweptRuns} unfinished run(s) to failed (crash recovery)`);
const eventBus = new EventBus(); // 共享事件中心：持久流订阅 + bridge run 事件，同一实例
const conversationQueues = new ConversationQueues(); // 共享 per-conv FIFO：chat 路由与任务执行同实例（#29）——产出会话被用户浏览聊天时任务 turn 仍严格串行
const runRegistry = new RunRegistry({ store, eventBus });
runRegistry.sweepCrashed(); // 重启：DB 里仍 running 的 run → failed + 「异常终止」brief（进程没在跑了）
runRegistry.reconcileBriefMessages(); // ADR-0025 决策 3：sweep 之后——终态但简报未发的 run 幂等补发（崩溃区间归零）
const deps: RunDeps = { store, userStore, streamRegistry, workspaceStore, taskStore, imStore: new ImStore(db), eventBus, conversationQueues, runRegistry };
const scheduler = new TaskScheduler({
  store: taskStore,
  executeTask: makeExecuteTask({ deps, queues: conversationQueues, eventBus }), // #29 真链：runTurn 同构、任务 pi 无 bridge
});
deps.scheduler = scheduler;
scheduler.start(); // 每 60s tick；DB 为真相，重启后按 nextFireAt 继续

// 飞书通道（spec #55）：凭证就位才接（缺一 → 无飞书，零侵入）。
// T1（#56）出站：bus hitl 帧 → owner 绑定 → send。
// T2（#57）入站：长连接（免公网 raw protobuf 事件）→ 文本回流 handleImInbound → 回复回发（同一 transport）。
if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
  const feishu = new FeishuTransport({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
  const imRouter = new ImOutboundRouter({ store, imStore: deps.imStore!, bus: eventBus, platform: feishu });
  imRouter.subscribeAll();
  const textPending = makePendingTextCache(); // 选择卡待确认文本（T6：多卡消歧——入站写/卡回调读，同实例）
  const feishuInbound = makeFeishuInbound(deps, feishu, textPending);
  const longConnection = new FeishuLongConnection({
    appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET,
    onEvent: (p) => { feishuInbound(p).catch((e) => console.error("[im] 入站处理失败:", e)); },
    onCard: (p) => handleCardAction(deps, p, textPending), // T4 按钮回调 + T6 选择卡点选
    log: (m) => console.log("[im]", m),
  });
  longConnection.start();
  console.log("[im] 飞书出站 + 长连接已接线");
}
await bootstrapAdmin(userStore); // env 设了 bootstrap admin 则幂等 upsert（否则走纯 dev 阀）
const app = createApp(deps);
warnIfNoSandbox(); // 逃生阀开启时显眼告警（ADR-0011 A1）

// h5：默认绑 loopback（防公网裸暴露）；prod 经反代时用 HOST 覆盖 + 真 auth。
const server = Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? "127.0.0.1",
  idleTimeout: 255, // SSE 持久流长连：默认 10s 会在事件间隙（pi 首 token 延迟常 >10s）掐断 GET /stream
  fetch: (req) => app.fetch(req),
});
startBridge(BRIDGE_PORT, { runRegistry, store, eventBus }); // bridge RPC（loopback:3199，pi↔server；nonce 闸；#11/#14/#16）
console.log(`agentany server on http://localhost:${server.port}`);
console.log(`agentany bridge on http://localhost:${BRIDGE_PORT} (pi↔server RPC, nonce-gated)`);
