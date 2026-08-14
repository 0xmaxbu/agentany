import { createApp } from "./app";
import { openDbMigrated } from "./db/client";
import { WorkflowStore } from "./workflow-engine/store";
import { EventBus } from "./chat/eventbus";
import { RunRegistry } from "./runs/registry";
import { UserStore } from "./auth/store";
import { StreamRegistry } from "./chat/stream-registry";
import { WorkspaceStore } from "./workspaces/store";
import { bootstrapAdmin } from "./auth/bootstrap";
import { PORT } from "./config";
import { warnIfNoSandbox } from "./pi/sandbox";
import { startBridge, BRIDGE_PORT } from "./bridge/server";
import type { RunDeps } from "./runs";

const db = openDbMigrated(); // 启动跑迁移（data/db.sqlite）
const store = new WorkflowStore(db);
const userStore = new UserStore(db); // 真 auth（ADR-0014）：与 store 共享同一 db
const streamRegistry = new StreamRegistry(); // 活跃 SSE 登记：token 吊销时强断
const workspaceStore = new WorkspaceStore(db); // 工作空间 + 名单（ADR-0018）：与 store/userStore 共享同一 db；公司 ws 由迁移 seed
const eventBus = new EventBus(); // 共享事件中心：持久流订阅 + bridge run 事件，同一实例
const runRegistry = new RunRegistry({ store, eventBus });
runRegistry.sweepCrashed(); // 重启：DB 里仍 running 的 run → failed（进程没在跑了）
await bootstrapAdmin(userStore); // env 设了 bootstrap admin 则幂等 upsert（否则走纯 dev 阀）
const deps: RunDeps = { store, userStore, streamRegistry, workspaceStore, eventBus, runRegistry };
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
