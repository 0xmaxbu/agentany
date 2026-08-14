// 测试装配：一个 :memory: db 同时喂 store + userStore（否则两库隔离看不见彼此表）。
// overrides 在默认之后展开——需要自带 store/runPiFactory 等的测试可覆盖（userStore/streamRegistry 用默认即可，非 auth 测试不触达）。
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { ProjectStore } from "../src/projects/store";
import type { RunDeps } from "../src/runs";

export function makeDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  const db = openDbMigrated(":memory:");
  return {
    store: new WorkflowStore(db),
    userStore: new UserStore(db),
    streamRegistry: new StreamRegistry(),
    projectStore: new ProjectStore(db), // 与 store/userStore 共享同一 db（listMembers join users）
    ...overrides,
  };
}

/** 已有 store 的测试用：userStore/projectStore 独立 db（非 auth/项目测试不触达）、streamRegistry 真实（/stream 用）。overrides 可覆盖。 */
export function fullDeps(store: WorkflowStore, overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    store,
    userStore: new UserStore(openDbMigrated(":memory:")),
    streamRegistry: new StreamRegistry(),
    projectStore: new ProjectStore(openDbMigrated(":memory:")),
    ...overrides,
  };
}
