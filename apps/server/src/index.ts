import { createApp } from "./app";
import { openDbMigrated } from "./db/client";
import { WorkflowStore } from "./workflow-engine/store";
import { EventBus } from "./chat/eventbus";
import { RunRegistry } from "./runs/registry";
import { PORT } from "./config";
import { warnIfNoSandbox } from "./pi/sandbox";
import { startBridge, BRIDGE_PORT } from "./bridge/server";
import type { RunDeps } from "./runs";

const db = openDbMigrated(); // 启动跑迁移（data/db.sqlite）
const store = new WorkflowStore(db);
const eventBus = new EventBus(); // 共享事件中心：持久流订阅 + bridge run 事件，同一实例
const runRegistry = new RunRegistry({ store, eventBus });
runRegistry.sweepCrashed(); // 重启：DB 里仍 running 的 run → failed（进程没在跑了）
const deps: RunDeps = { store, eventBus, runRegistry };
const app = createApp(deps);
warnIfNoSandbox(); // 逃生阀开启时显眼告警（ADR-0011 A1）

// h5：默认绑 loopback（防公网裸暴露）；prod 经反代时用 HOST 覆盖 + 真 auth。
const server = Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? "127.0.0.1",
  fetch: (req) => app.fetch(req),
});
startBridge(BRIDGE_PORT, { runRegistry, store, eventBus }); // bridge RPC（loopback:3199，pi↔server；nonce 闸；#11/#14/#16）
console.log(`agentany server on http://localhost:${server.port}`);
console.log(`agentany bridge on http://localhost:${BRIDGE_PORT} (pi↔server RPC, nonce-gated)`);
