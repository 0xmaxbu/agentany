// 测试装配：一个 :memory: db 同时喂 store + userStore（否则两库隔离看不见彼此表）。
// overrides 在默认之后展开——需要自带 store/runPiFactory 等的测试可覆盖（userStore/streamRegistry 用默认即可，非 auth 测试不触达）。
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { ImStore } from "../src/im/store";
import { RunLifecycle } from "../src/runs/lifecycle";
import { EventBus } from "../src/chat/eventbus";
import type { RunDeps } from "../src/runs";

// ADR-0031：runLifecycle 默认装配（四 store + 独立 EventBus）。overrides 展开后才建——runPiFactory 覆盖也进 lifecycle。
// 覆盖传了 runLifecycle 则用之（bridge/特殊配置测试）。
function withDefaultLifecycle(base: RunDeps, store: Stores, overrides: Partial<RunDeps>): RunDeps {
  if (Object.prototype.hasOwnProperty.call(overrides, "runLifecycle")) return { ...base, ...overrides }; // 显式（含 undefined=unavailable 测试）优先
  return { ...base, ...overrides, runLifecycle: new RunLifecycle({ runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus: new EventBus(), remote: store.remote, runPiFactory: overrides.runPiFactory ?? base.runPiFactory }) };
}

export function makeDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  const db = openDbMigrated(":memory:");
  const store = createStores(db);
  const base: RunDeps = {
    runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback,
    userStore: new UserStore(db),
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db), // 与 store/userStore 共享同一 db（名单 join users；公司 ws 由迁移 seed）
    taskStore: new ScheduledTaskStore(db, store.chat), // #25：三表与蒸馏 seed 同 db；产出会话派生复用 store.createConversation
    imStore: new ImStore(db), // #51/T2：IM 身份绑定（IM 已接线）；IM 专项测试可覆盖
    remote: store.remote, // ADR-0033/R-1：remote_clients/grants/cfg/pending（R-2 起 device routes 消费）
  };
  return withDefaultLifecycle(base, store, overrides);
}

/** 已有 store 的测试用：userStore/workspaceStore 独立 db、streamRegistry 真实（/stream 用）。overrides 可覆盖。 */
export function fullDeps(store: Stores, overrides: Partial<RunDeps> = {}): RunDeps {
  const base: RunDeps = {
    runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback,
    userStore: new UserStore(openDbMigrated(":memory:")),
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(openDbMigrated(":memory:")),
    remote: store.remote,
  };
  return withDefaultLifecycle(base, store, overrides);
}
