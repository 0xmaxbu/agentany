// 测试装配：一个 :memory: db 同时喂 store + userStore（否则两库隔离看不见彼此表）。
// overrides 在默认之后展开——需要自带 store/runPiFactory 等的测试可覆盖（userStore/streamRegistry 用默认即可，非 auth 测试不触达）。
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import type { RunDeps } from "../src/runs";

export function makeDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  const db = openDbMigrated(":memory:");
  return {
    store: new WorkflowStore(db),
    userStore: new UserStore(db),
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db), // 与 store/userStore 共享同一 db（名单 join users；公司 ws 由迁移 seed）
    ...overrides,
  };
}

/** 已有 store 的测试用：userStore/workspaceStore 独立 db、streamRegistry 真实（/stream 用）。overrides 可覆盖。 */
export function fullDeps(store: WorkflowStore, overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    store,
    userStore: new UserStore(openDbMigrated(":memory:")),
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(openDbMigrated(":memory:")),
    ...overrides,
  };
}
