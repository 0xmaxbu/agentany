import { createApp } from "./app";
import { openDbMigrated } from "./db/client";
import { createStores } from "./stores"; // ADR-0030 决策 5：四域 store 单点装配（boot 与 test/deps 共用）
import { EventBus } from "./chat/eventbus";
import { RunLifecycle, type RunLifecycleDeps } from "./runs/lifecycle"; // deviceRpc 晚绑定需显式类型
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
import { FeishuPlatformAdapter } from "./im/feishu/adapter";
import { handleImEvent } from "./im/dispatch";
import { makePendingTextCache } from "./im/pending-text";
import { ImOutboundRouter } from "./im/outbound-router";
import type { RunDeps } from "./runs";
import { serve } from "./device/server"; // ADR-0033/R-2：HTTP + 设备 WS 同一 serve（升级前验 token）
import { DeviceRegistry } from "./device/registry";
import { DeviceEnvRpc } from "./device/env"; // ADR-0033/R-4：环境检测 RPC
import { DeviceToolRpc } from "./device/tool"; // ADR-0033/R-5：远端工具转发

const db = openDbMigrated(); // 启动跑迁移（data/db.sqlite）
ensureKnowledgeRepo(); // #35：knowledge repo 就位（空则 init+布局+skills 种子；已有则 no-op）
const { runs: runStore, chat: chatStore, hitl: hitlStore, feedback: feedbackStore, remote: remoteStore } = createStores(db); // ADR-0030 决策 5：{runs,chat,hitl,feedback,remote} 清洗为 RunDeps 字段名
const userStore = new UserStore(db); // 真 auth（ADR-0014）：与 store 共享同一 db
const streamRegistry = new StreamRegistry(); // 活跃 SSE 登记：token 吊销时强断
const workspaceStore = new WorkspaceStore(db); // 工作空间 + 名单（ADR-0018）：与 store/userStore 共享同一 db；公司 ws 由迁移 seed
const taskStore = new ScheduledTaskStore(db, chatStore); // 定时任务三表（#25/ADR-0021）：共享 db；产出会话复用 chatStore.createConversation
taskStore.reviveSeedNextFire(); // seed nextFireAt=epoch 占位 → 启动算真值（enabled=0 保持禁用，M5 装配时启用）
const sweptRuns = taskStore.sweepUnfinishedRuns(); // 重启：执行中崩溃残留的 task_runs 收 failed（DB 真相）
if (sweptRuns > 0) console.log(`[scheduler] swept ${sweptRuns} unfinished run(s) to failed (crash recovery)`);
const eventBus = new EventBus(); // 共享事件中心：持久流订阅 + bridge run 事件，同一实例
const conversationQueues = new ConversationQueues(); // 共享 per-conv FIFO：chat 路由与任务执行同实例（#29）——产出会话被用户浏览聊天时任务 turn 仍严格串行
const lifecycleDeps: RunLifecycleDeps = { runStore, chatStore, hitlStore, eventBus, remote: remoteStore }; // ADR-0033/R-3：preflight 需 remote（授权/启停/设备在线）；deviceRpc 晚绑定（envRpc 依赖 runLifecycle 建）
const runLifecycle = new RunLifecycle(lifecycleDeps); // ADR-0031：run 生命周期单组合根（只学三域面）
runLifecycle.sweepCrashed(); // 重启：DB 里仍 running 的 run → failed + 「异常终止」brief（进程没在跑了）
runLifecycle.reconcileBriefMessages(); // ADR-0025 决策 3：sweep 之后——终态但简报未发的 run 幂等补发（崩溃区间归零）
const deps: RunDeps = { runStore, chatStore, hitlStore, feedbackStore, userStore, streamRegistry, workspaceStore, taskStore, imStore: new ImStore(db), eventBus, conversationQueues, runLifecycle, remote: remoteStore };
const deviceRegistry = new DeviceRegistry(); // ADR-0033/R-2：在线设备 registry（单机登录 + preflight/转发寻址）
deps.deviceRegistry = deviceRegistry; // device-logout 关闭在线连接者与 serve() 共享同一实例

// ADR-0033/R-4：设备环境检测 RPC——route 收 env_report/env_remediated；onReady 复检通过 → 重入 start 自动续
const envRpc = new DeviceEnvRpc({
  registry: deviceRegistry,
  remote: remoteStore,
  onReady: (p) => {
    let input: unknown = {};
    try { input = p.input ? JSON.parse(p.input) : {}; } catch { /* 缺/坏入参按空（罕见） */ }
    const role = userStore.getUserById(p.userId)?.role ?? "member";
    void runLifecycle
      .start({
        workflowId: p.workflowId,
        input,
        workspaceId: p.workspaceId ?? undefined,
        conversationId: p.conversationId ?? undefined,
        caller: { id: p.userId, role },
        skipEnvCheck: true, // 刚复检通过：授权/启停/设备在线照常，仅跳过环境 RPC
        pendingAutoResume: { pendingId: p.id }, // 复检通过即批准：跳过审批门，createRun 后移除 pending
      })
      .catch((e) => console.log("[env] auto-resume failed", p.id, e instanceof Error ? e.message : e));
  },
});
lifecycleDeps.deviceRpc = envRpc; // 晚绑定（preflight ④ 调用时读取）
envRpc.sweepExpired(); // R-4 boot：启动即扫已过期 pending（TTL 超时不再永久挂起）
setInterval(() => envRpc.sweepExpired(), 60_000); // R-4：周期 TTL 清扫（与 TaskScheduler 同刻钟节奏）

// ADR-0033/R-5：远端工具转发 RPC——tool_call/tool_result async-map；设备断连 → 在飞全失败
const toolRpc = new DeviceToolRpc({ registry: deviceRegistry });
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
  const feishuTransport = new FeishuTransport({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
  const feishu = new FeishuPlatformAdapter({
    transport: feishuTransport,
    longConnection: { appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET, log: (m) => console.log("[im]", m) },
  }); // ADR-0032：双向 adapter（出站 REST + 入站长连接）
  const imRouter = new ImOutboundRouter({ chatStore, hitlStore, imStore: deps.imStore!, bus: eventBus, platform: feishu }); // ADR-0030：出站路由只学 chat+hitl 面
  imRouter.subscribeAll();
  const textPending = makePendingTextCache(); // 选择卡待确认文本（T6：多卡消歧——入站写/卡回调读，同实例）
  const listener = (e: import("./im/types").ImInboundEvent) => handleImEvent(deps, e, feishu, textPending); // 领域单入口（决策 1）
  feishu.start(listener); // 连接 + ack + 路由 raw→typed→handleImEvent；进程生命周期内不主动停（热重启由进程回收）
  console.log("[im] 飞书出站 + 长连接已接线");
}
await bootstrapAdmin(userStore); // env 设了 bootstrap admin 则幂等 upsert（否则走纯 dev 阀）
const app = createApp(deps);
warnIfNoSandbox(); // 逃生阀开启时显眼告警（ADR-0011 A1）

// h5：默认绑 loopback（防公网裸暴露）；prod 经反代时用 HOST 覆盖 + 真 auth。
// ADR-0033/R-2：同一 Bun.serve 兼 HTTP + 设备 WS（/ws/device 升级前验 token；SSE 长连 idleTimeout=255 沿用）。
const server = serve(app, {
  port: PORT,
  hostname: process.env.HOST ?? "127.0.0.1",
  idleTimeout: 255,
  userStore,
  remote: remoteStore,
  registry: deviceRegistry,
  onDeviceMessage: (entry, msg) => {
    const m = msg as Record<string, unknown>;
    if (!envRpc.route(entry, m)) toolRpc.route(entry, m); // R-4 env 三件套 / R-5 tool_result
  },
  onDeviceClose: (entry) => {
    toolRpc.failAllForUser(entry.userId, `device disconnected (${entry.deviceId})`); // R-5：在飞工具调用失败（run 收尾载体失联）
  },
});
startBridge(BRIDGE_PORT, { runLifecycle, runStore, chatStore, hitlStore, eventBus, userStore, toolRpc }); // bridge RPC（loopback:3199，pi↔server；nonce 闸；#11/#14/#16；R-3 身份推导；R-5 remote-tool）
console.log(`agentany server on http://localhost:${server.port}`);
console.log(`agentany bridge on http://localhost:${BRIDGE_PORT} (pi↔server RPC, nonce-gated)`);
