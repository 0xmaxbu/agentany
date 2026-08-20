// ADR-0031 决策 8：runs.ts 收敛为 RunDeps + 错误类 + makeRunId（组合/verdict/投递全部移到 runs/lifecycle.ts）。
import type { RunPiOptions } from "./pi/runPi";
import { makeRunPi, makeRunPiStream } from "./pi/runPi-factory";
import type { RunPiResult } from "./workflow-engine/defineWorkflow";
import type { RunsStore } from "./runs/store"; // ADR-0030 决策 6：RunDeps 只见 runs 面，跨域经 deps.*Store
import type { ChatStore } from "./chat/store";
import type { HitlStore } from "./hitl/store";
import type { FeedbackStore } from "./feedback/store";
import type { EventBus } from "./chat/eventbus";
import type { RunLifecycle } from "./runs/lifecycle";
import type { UserStore } from "./auth/store";
import type { StreamRegistry } from "./chat/stream-registry";
import type { WorkspaceStore } from "./workspaces/store";
import type { ScheduledTaskStore } from "./scheduled-tasks/store";
import type { TaskScheduler } from "./scheduled-tasks/scheduler";
import type { ConversationQueues } from "./chat/queue";
import type { ImStore } from "./im/store";
import type { RemoteStore } from "./remote/store"; // ADR-0033/R-1：远端执行四表
import type { DeviceRegistry } from "./device/registry"; // ADR-0033/R-2：在线设备内存 registry（单机登录/转发寻址）

export interface RunDeps {
  runStore: RunsStore; // run/log 域（ADR-0030：跨域生命周期事务按 subject=run 归此）
  chatStore: ChatStore; // conversations + messages
  hitlStore: HitlStore; // hitl 提问卡（ask/approval/task）
  feedbackStore: FeedbackStore; // 反馈（多态挂载 + 蒸馏增量水位）
  userStore: UserStore; // 真 auth（ADR-0014）：身份解析 + 用户/token CRUD
  streamRegistry: StreamRegistry; // 活跃 SSE 登记：token 吊销时强断（不杀 run）
  remote?: RemoteStore; // ADR-0033：remote_clients/grants/cfg/pending 四表（R-3 preflight、R-4 env、R-5 文件）
  deviceRegistry?: DeviceRegistry; // ADR-0033/R-2：在线设备 registry（device-logout 关连者与 serve() 共享）
  workspaceStore: WorkspaceStore; // 工作空间 + 名单（ADR-0018）：鉴权边界唯一口径
  taskStore?: ScheduledTaskStore; // 定时任务三表（#25/ADR-0021）：与 store 共享 db；可选——既有测试装配不破坏
  imStore?: ImStore; // IM 身份绑定（spec #49 决策 6）：共享 db；可选——IM 未立项/未装配时零侵入
  scheduler?: TaskScheduler; // 调度循环（#26）：手动调用入口；可选——未装配时 /run 503
  conversationQueues?: ConversationQueues; // 共享 per-conv FIFO（#29）：chat 路由与任务执行同一实例——同会话严格串行（防 pi session 并发写坏）；缺省路由自建（测试兼容）
  runPiFactory?: typeof makeRunPi; // 测试可换 stub（di）
  runPiStreamFactory?: typeof makeRunPiStream; // chat 切片①：测试注确定性 delta stub（di）
  runPiFn?: (opts: RunPiOptions) => Promise<RunPiResult>; // C1/#66：system-headless 的 runPi 直调 seam（含 sandboxAllow，比 runPiFactory 更全）；缺省真 runPi
  eventBus?: EventBus; // 共享事件中心（持久流 + bridge run 事件；prod 由 index 注入）
  listWorkflows?: () => { id: string; name?: string; description?: string; inputSchema?: unknown }[]; // ADR-0029：runTurn 每轮注入的工作流目录——缺省全局 registry（默认同 listWorkflows）；测试可注 stub 免触全局态
  runLifecycle?: RunLifecycle; // ADR-0031：run 生命周期单组合根（start/resume/read/abort/sweep/reconcile/stop）
  signal?: AbortSignal;
  log?: (...a: unknown[]) => void;
}

export class WorkflowNotFound extends Error {
  constructor(id: string) { super(`workflow not found: ${id}`); this.name = "WorkflowNotFound"; }
}

// ADR-0033 / R-3（#75）：preflight 结构化错误契约（三入口共用，供通知/呈现）。
export type WorkflowStartErrorCode =
  | "not_granted" // 未授权（workflow_grants 默认锁定：无授权行仅 admin）
  | "disabled" // workflow_cfg.enabled=false：停用只拦新开
  | "device_offline" // 含 remote 工具但发起用户设备离线
  | "env_fail" // R-4：环境硬失败（含缺失表格）
  | "env_installable_pending"; // R-4：环境缺软件因素 → 挂起（pending_start 已建）
export class WorkflowStartError extends Error {
  constructor(
    public code: WorkflowStartErrorCode,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "WorkflowStartError";
  }
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

// h8：强随机 runId（runId 是资源主键 + 当前事实上的能力令牌，不得弱）。runId 唯一定义点（RunLifecycle 复用）。
export const makeRunId = (): string => "r_" + globalThis.crypto.randomUUID();