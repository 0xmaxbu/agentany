// 组合根·装配：start/resume 时 makeRunPi→注入 ctx→调 runner（F4）。runner 保持纯。
import { getWorkflow } from "./registry";
import { run, resume, type RunCtx } from "./workflow-engine/runner";
import { makeRunPi, makeRunPiStream } from "./pi/runPi-factory";
import { assertValidWorkspaceId } from "./config";
import { resolveScopePaths, scopeOf } from "./scope";
import { validate } from "./workflow-engine/schema";
import type { Workflow } from "./workflow-engine/defineWorkflow";
import type { WorkflowStore } from "./workflow-engine/store";
import type { EventBus } from "./chat/eventbus";
import type { RunRegistry } from "./runs/registry";
import type { UserStore } from "./auth/store";
import type { StreamRegistry } from "./chat/stream-registry";
import type { WorkspaceStore } from "./workspaces/store";
import type { ScheduledTaskStore } from "./scheduled-tasks/store";

export interface RunDeps {
  store: WorkflowStore;
  userStore: UserStore; // 真 auth（ADR-0014）：身份解析 + 用户/token CRUD
  streamRegistry: StreamRegistry; // 活跃 SSE 登记：token 吊销时强断（不杀 run）
  workspaceStore: WorkspaceStore; // 工作空间 + 名单（ADR-0018）：鉴权边界唯一口径
  taskStore?: ScheduledTaskStore; // 定时任务三表（#25/ADR-0021）：与 store 共享 db；可选——既有测试装配不破坏
  runPiFactory?: typeof makeRunPi; // 测试可换 stub（di）
  runPiStreamFactory?: typeof makeRunPiStream; // chat 切片①：测试注确定性 delta stub（di）
  eventBus?: EventBus; // 共享事件中心（持久流 + bridge run 事件；prod 由 index 注入）
  runRegistry?: RunRegistry; // 异步 run 句柄（bridge /run/* 用）
  signal?: AbortSignal;
  log?: (...a: unknown[]) => void;
}

export class WorkflowNotFound extends Error {
  constructor(id: string) { super(`workflow not found: ${id}`); this.name = "WorkflowNotFound"; }
}
export class RunNotFound extends Error {
  constructor(id: string) { super(`run not found: ${id}`); this.name = "RunNotFound"; }
}
// h2：输入不符 inputSchema。
export class InvalidInput extends Error {
  constructor(error: string) { super(`invalid input: ${error}`); this.name = "InvalidInput"; }
}
// chat 切片①（ADR-0009）。
export class ConversationNotFound extends Error {
  constructor(id: string) { super(`conversation not found: ${id}`); this.name = "ConversationNotFound"; }
}
export class QueueFull extends Error {
  constructor(id: string) { super(`conversation queue full: ${id}`); this.name = "QueueFull"; }
}

const sessionIdFor = (runId: string) => `run-${runId}`;
// h8：强随机 runId（runId 是资源主键 + 当前事实上的能力令牌，不得弱）。runId 唯一定义点（RunRegistry 复用）。
export const makeRunId = (): string => "r_" + globalThis.crypto.randomUUID();

function buildCtx(wf: Workflow, workspaceId: string, runId: string, deps: RunDeps): RunCtx {
  const factory = deps.runPiFactory ?? makeRunPi;
  const scope = scopeOf(workspaceId);
  const { cwd } = resolveScopePaths(scope, workspaceId);
  const runPi = factory({
    extensions: wf.extensions, scope, workspaceId: workspaceId, sessionId: sessionIdFor(runId),
  });
  return {
    runPi,
    workspaceId,
    cwd,
    signal: deps.signal ?? new AbortController().signal,
    log: deps.log ?? (() => {}),
  };
}

export async function startRun(deps: RunDeps, workflowId: string, workspaceId: string, input: unknown) {
  const wf = getWorkflow(workflowId);
  if (!wf) throw new WorkflowNotFound(workflowId);
  if (scopeOf(workspaceId) === "workspace") assertValidWorkspaceId(workspaceId); // h1：路径关键输入，先校验（general 分支不进目录拼接）
  const v = validate(wf.inputSchema as any, input); // h2：按 inputSchema 校验
  if (!v.ok) throw new InvalidInput(v.error);
  const runId = makeRunId();
  deps.store.createRun({ runId, workflowId, workspaceId, input });
  return run(wf, deps.store, runId, buildCtx(wf, workspaceId, runId, deps));
}

export async function resumeRun(deps: RunDeps, runId: string, resumeData: unknown) {
  const row = deps.store.getRun(runId);
  if (!row) throw new RunNotFound(runId);
  const wf = getWorkflow(row.workflowId);
  if (!wf) throw new WorkflowNotFound(row.workflowId);
  return resume(wf, deps.store, runId, resumeData, buildCtx(wf, row.workspaceId, runId, deps));
}
