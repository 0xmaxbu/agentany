// RunLifecycle（ADR-0031，ticket #14 收编）：run 生命周期单组合根——组合、verdict、投递、收尾一体。
// 替换 RunRegistry：runner 保持纯引擎（store 可注入、runPi 在 ctx）。
// - 单组合根 start({workflowId,input,workspaceId?,conversationId?,approved?,sync?})：
//   validate → decide() 审批门 → createRun → 注册句柄 → sync=true ? await : detached。ctx 装配一份。
// - verdict 单源：engine.verdictOf（同步预检与 resumeInner 同源）。
// - 终态投递（completed/failed/suspended 三分支）私有；status 单写者守——lifecycle 零直写
//   （终态经 setTerminalBrief，挂起/换步经引擎原子面 appendStep/suspendedStep）。
import { run, resume, type RunCtx, type RunProgress, type RunOutcome, type ResumeOutcome, verdictOf } from "../workflow-engine/runner";
import { getWorkflow } from "../registry";
import { makeRunPi, type ConfiguredRunPi } from "../pi/runPi-factory";
import { resolveScopePaths, scopeOf, type Scope } from "../scope";
import { validate } from "../workflow-engine/schema";
import { decide } from "../security/policy";
import { buildBriefMessage, extractArtifacts, extractBrief, extractNoteBrief, stepListFallback, truncateForRead } from "./briefing";
import type { RunsStore, RunRow, RunStatus } from "./store";
import type { HitlStore } from "../hitl/store";
import type { ChatStore } from "../chat/store";
import type { Workflow } from "../workflow-engine/defineWorkflow";
import type { EventBus, Frame } from "../chat/eventbus";
import type { UserRole } from "../auth/store";
import type { RemoteStore } from "../remote/store";
import { getTool } from "../tool-registry"; // ADR-0033：workflow.tools → registry 的 remote 判定
import { WorkflowNotFound, InvalidInput, WorkflowStartError, makeRunId } from "../runs";

// 句柄只留「运行期需要、DB 没有」的：abort 控制器 + scope/session（resume 重建 ctx 用）。
// 状态走 DB（ADR-0007：进程无内存态）。
export interface RunHandle {
  conversationId: string;
  scope: Scope;
  sessionId: string;
  abortCtrl: AbortController;
}

export interface RunLifecycleDeps {
  runStore: RunsStore; // run/log 域（引擎契约面）
  chatStore: ChatStore; // getConversation（start 定位会话 ws/scope）
  hitlStore: HitlStore; // 审批门（幂等查/建卡）+ 挂起卡行直读（帧素材）
  eventBus: EventBus;
  remote?: RemoteStore; // ADR-0033/R-1：grants/cfg/remote_clients（R-3 preflight 消费）
  // ADR-0033/R-3：工作流解析可注入（同 ADR-0029 listWorkflows 模式）——测试可挂含 remote 工具的测试工作流，免触全局态
  getWorkflow?: typeof getWorkflow;
  runPiFactory?: (opts: { extensions?: string[]; scope: Scope; workspaceId: string | null; sessionId: string }) => ConfiguredRunPi;
}

// #18 审批门：start 的三态出口。allow→running；deny→拒（当前 POSTURES 下对已注册工作流不可达，防御）；
// require_approval→建审批卡、不 createRun。approved flag（仅 /approvals/decide 内部用）跳 policy 直跑。
// sync=true → 返回 RunOutcome（await 完的真结局）；detached → running。
export type StartResult =
  | { runId: string; status: "running" }
  | { status: "denied"; reason: string }
  | { status: "needs_approval"; questionId: number }
  | RunOutcome;

export class RunLifecycle {
  private handles = new Map<string, RunHandle>();

  constructor(private deps: RunLifecycleDeps) {}

  /** 单组合根（ADR-0031 决策 2）：唯一 gate = validate → decide() → createRun → 句柄 → sync/ detached。 */
  async start(p: {
    workflowId: string;
    input: unknown;
    workspaceId?: string; // 无会话直调（HTTP 同步路由）用
    conversationId?: string; // bridge/chat（审批卡/推流需会话锚）
    approved?: boolean;
    caller?: { id: string; role: UserRole }; // ADR-0033/R-3：三入口（HTTP/bridge/chat 桥工具）传来的发起人身份——preflight 依据
    sync?: boolean; // true=await 完直接返 RunOutcome（HTTP 同步）；缺省=detached 后台续跑
  }): Promise<StartResult> {
    const wf = (this.deps.getWorkflow ?? getWorkflow)(p.workflowId);
    if (!wf) throw new WorkflowNotFound(p.workflowId);
    const v = validate(wf.inputSchema as any, p.input);
    if (!v.ok) throw new InvalidInput(v.error);

    // ADR-0033/R-3（#75）：单一 preflight 校验点（授权→启停→remote/设备在线→环境钩子占位）。
    // 三入口 [HTTP(principal) / bridge(nonce→conv→user) / chat 桥工具] 全汇于此、一处生效。
    // approved 续跑（审批卡已通过前一轮 preflight）与无 caller 直调（系统/测试内部）不重复拦截。
    if (!p.approved && p.caller) this.preflight(p.caller, wf);

    // #18 审批门（统一堵口：HTTP 直调与 bridge 同一条 gate）。validate 已过→审批卡只为合法 input 弹。
    if (!p.approved) {
      const verdict = decide(p.workflowId);
      if (verdict.decision === "deny") return { status: "denied", reason: verdict.reason };
      if (verdict.decision === "require_approval") return this.requireApproval(p, wf);
    }

    let workspaceId = p.workspaceId;
    let conversationId: string | undefined;
    if (p.conversationId !== undefined) {
      const conv = this.deps.chatStore.getConversation(p.conversationId);
      if (!conv) throw new Error(`conversation not found: ${p.conversationId}`);
      workspaceId = conv.workspaceId;
      conversationId = p.conversationId;
    }
    if (!workspaceId) throw new Error("workspaceId or conversationId required");

    const runId = makeRunId();
    this.deps.runStore.createRun({ runId, workflowId: p.workflowId, workspaceId, conversationId, input: p.input });

    const abortCtrl = new AbortController();
    this.handles.set(runId, { conversationId: conversationId ?? "", scope: scopeOf(workspaceId), sessionId: `run-${runId}`, abortCtrl });
    const ctx = this.ctxFor(wf, workspaceId, runId, abortCtrl);

    if (p.sync) {
      const outcome = await run(wf, this.deps.runStore, runId, ctx); // 引擎诚实化：顶层 catch-all → failed
      // 同步也走生命周期投递（终态简报/挂起帧；无会话 → publish noop，仅落库）
      this.publishOutcome(conversationId ?? "", runId, outcome);
      return outcome;
    }
    void this.runDetached(runId, conversationId ?? "", wf, ctx); // detached：fire-and-forget
    return { runId, status: "running" };
  }

  /** ADR-0033/R-3（#75）：preflight 校验链——①授权（workflow_grants 默认锁定）→ ②启停（cfg.enabled）
   *  → ③含 remote 工具则设备在线判定 → ④环境检测钩子占位（R-4 落地 fail_installable → pending）。
   *  非 remote 工作流不受设备检查影响（回归护栏）；授权/启停对所有工作流生效。被拒 = 抛 WorkflowStartError（三入口结构化）。 */
  private preflight(caller: { id: string; role: UserRole }, wf: Workflow): void {
    const remote = this.deps.remote;
    // ① 授权：默认锁定（无授权行仅 admin 可跑）；未接线 store 时 member 失败关闭（安全兜底）
    if (caller.role !== "admin" && !remote?.isGranted(wf.id, caller.id)) {
      throw new WorkflowStartError("not_granted", `workflow ${wf.id} not granted to user ${caller.id}`);
    }
    // ② 启停：停用只拦新开（cfg.enabled 缺省 true）
    if (remote && !remote.getCfg(wf.id).enabled) {
      throw new WorkflowStartError("disabled", `workflow ${wf.id} is disabled`);
    }
    // ③ remote 工具 → 发起用户设备须在线
    const hasRemoteTools = wf.tools?.some((name) => getTool(name)?.remote === true) ?? false;
    if (hasRemoteTools && !remote?.hasOnlineClient(caller.id)) {
      throw new WorkflowStartError("device_offline", `workflow ${wf.id} requires remote tools; no online device for user ${caller.id}`);
    }
    // ④ 环境检测钩子占位（R-4 实现：check_environment → fail_hard/env_installable_pending → pending_starts）
  }

  /** #18 require_approval 出口：幂等建审批卡（同 conv+workflow 已有 pending → 复用）+ 发 hitl_request；不 createRun。 */
  private requireApproval(p: { conversationId?: string; workflowId: string; input: unknown }, wf: Workflow): StartResult {
    if (!p.conversationId) throw new InvalidInput("require_approval workflow can only start from a conversation (approval card needs a reply anchor)"); // ADR-0031 决策 2：HTTP 直调无会话锚 → 堵
    const prompt = `启动工作流「${wf.name ?? p.workflowId}」需审批`;
    const options = ["批准", "拒绝"];
    const existing = this.deps.hitlStore.getPendingApproval(p.conversationId, p.workflowId);
    if (existing) return { status: "needs_approval", questionId: existing.id }; // 幂等：防 pi 重调堆卡
    const questionId = this.deps.hitlStore.createQuestion({
      conversationId: p.conversationId, runId: null, kind: "approval",
      workflowId: p.workflowId, input: p.input, prompt, options,
    });
    this.deps.eventBus.publish(p.conversationId, {
      type: "hitl_request", questionId, runId: null, kind: "approval",
      workflowId: p.workflowId, prompt, options,
    });
    return { status: "needs_approval", questionId };
  }

  /** 续跑（#16 HITL 经 bridge 调）。同步段只判 verdict 即时返（rejected/idempotent/clean→running）；clean → detached 续跑。 */
  async resume(runId: string, resumeData: unknown): Promise<ResumeOutcome> {
    const row = this.deps.runStore.getRun(runId);
    if (!row) throw new Error(`run not found: ${runId}`);
    const verdict = verdictOf(this.deps.runStore, runId, resumeData); // 单一裁决源（决策 3）
    if (verdict.kind === "rejected") return { status: "suspended", runId, rejected: true, error: verdict.error };
    if (verdict.kind === "idempotent") return { status: verdict.status, runId, idempotent: true, note: "not currently suspended" };
    const wf = getWorkflow(row.workflowId);
    if (!wf) throw new WorkflowNotFound(row.workflowId);
    this.resumeDetached(wf, row, runId, resumeData); // fire-and-forget；ctx 在其内构建（verdict 保持纯同步零开销）
    return { status: "running", runId }; // clean 即时 verdict；续跑后台 detached
  }

  // detached 续跑：重建 ctx（句柄可能因重启不在）；rejected/idempotent 不发 run_*。run_resumed 补发在续跑真成立后。
  private resumeDetached(wf: Workflow, row: RunRow, runId: string, resumeData: unknown): void {
    const conversationId = row.conversationId ?? "";
    const publish = (frame: Frame) => {
      if (conversationId) this.deps.eventBus.publish(conversationId, frame);
    };
    const onProgress = (p: RunProgress) => publish({ ...p, runId });
    void (async () => {
      const abortCtrl = this.handles.get(runId)?.abortCtrl ?? new AbortController();
      const ctx = this.ctxFor(wf, row.workspaceId, runId, abortCtrl);
      const outcome = await resume(wf, this.deps.runStore, runId, resumeData, ctx, onProgress); // 引擎诚实化：不越状态机
      if (!("rejected" in outcome) && !("idempotent" in outcome)) {
        publish({ type: "run_resumed", runId }); // 真续跑成立才补发（顺序仅影响展示，终值正确）
        this.publishOutcome(conversationId, runId, outcome as RunOutcome); // publishTo="" 时只落终态（status 单写者），headless 也收口
      }
    })();
  }

  /** 读 run 状态/步骤/最新输出（chat read_run 经 bridge 调）。 */
  read(runId: string): { runId: string; status: string; steps: { seq: number; stepId: string; status: string }[]; latestOutput: unknown } | null {
    const r = this.deps.runStore.getRun(runId);
    if (!r) return null;
    const log = this.deps.runStore.getLog(runId);
    const last = log[log.length - 1];
    return {
      runId,
      status: r.status,
      steps: log.map((e) => ({ seq: e.seq, stepId: e.stepId, status: e.status })),
      latestOutput: truncateForRead(last?.output ?? null), // ADR-0025 决策 8：8k 硬截断 + 尾注
    };
  }

  /** abort 一个 run（kill 其 pi 子进程）。 */
  abort(runId: string): boolean {
    const h = this.handles.get(runId);
    if (h) {
      h.abortCtrl.abort();
      return true;
    }
    return false;
  }

  /** boot 调：DB 里仍 running 的 run 标 failed（重启=进程没在跑了）——同步写「异常终止」brief（决策 3）。返处理数。 */
  sweepCrashed(): number {
    return this.deps.runStore.markRunningAsFailed();
  }

  /** ADR-0025 决策 3 + G2 扩窗（决策 6）：终态且 (brief 缺 OR 简报未发) 的 run 幂等补发简报
   *  （brief 缺者从 log 兜底派生）。排除已删会话。返补发数。 */
  reconcileBriefMessages(): number {
    const rows = this.deps.runStore.listReconcileCandidates();
    let n = 0;
    for (const row of rows) {
      const publish = (frame: Frame) => {
        if (row.conversationId) this.deps.eventBus.publish(row.conversationId, frame);
      };
      if (row.status === "completed") {
        // 补发文案：列里 brief 优先（单一真相）；brief 缺（扩窗）→ 从 log 兜底派生
        this.deliverBrief(publish, row.runId, row, "completed", { log: this.deps.runStore.getLog(row.runId), note: undefined, briefOverride: row.brief ?? undefined });
      } else {
        this.deliverBrief(publish, row.runId, row, "failed", { log: [], note: row.brief ?? "异常终止（进程重启）" });
      }
      n++;
    }
    return n;
  }

  /** #19 abort：停该会话所有 running run。有句柄→abortCtrl.abort()（杀 pi → 引擎 failed + publishOutcome，单次）；
   *  无句柄（重启 stale）→终态收编（setTerminalBrief 同通道）。返停数。 */
  stopConversationRuns(conversationId: string): number {
    const ids = this.deps.runStore.listRunningRunIds(conversationId);
    for (const runId of ids) {
      const h = this.handles.get(runId);
      if (h) {
        h.abortCtrl.abort(); // runDetached catch → publishOutcome(failed) 发一次 run_failed + 简报（不重复）
      } else {
        // 无句柄（重启 stale）：终态收编（deliverBrief → setTerminalBrief；status+brief+简报同事务）
        this.publishOutcome(conversationId, runId, { status: "failed", runId, note: "aborted (no handle)" });
      }
    }
    return ids.length;
  }

  // —— 内部 ——
  private ctxFor(wf: Workflow, workspaceId: string, runId: string, abortCtrl: AbortController): RunCtx {
    const factory = this.deps.runPiFactory ?? makeRunPi;
    const scope = scopeOf(workspaceId);
    const { cwd } = resolveScopePaths(scope, workspaceId);
    const runPi = factory({ extensions: wf.extensions, scope, workspaceId: workspaceId, sessionId: `run-${runId}` });
    return { runPi, workspaceId, cwd, signal: abortCtrl.signal, log: () => {} };
  }

  private async runDetached(runId: string, conversationId: string, wf: Workflow, ctx: RunCtx): Promise<RunOutcome> {
    const publish = (frame: Frame) => (conversationId ? this.deps.eventBus.publish(conversationId, frame) : undefined);
    const onProgress = (p: RunProgress) => publish({ ...p, runId }); // run_started 由 run() 发、经此透传（带 runId）
    const outcome = await run(wf, this.deps.runStore, runId, ctx, onProgress); // 引擎诚实化：top catch-all → failed
    // publishOutcome 内部 publishTo="" 时只落库（setTerminalBrief：status 单写者）+ 零帧——headless run 也要收口终态
    this.publishOutcome(conversationId, runId, outcome);
    return outcome;
  }

  // outcome（clean 结局：completed/suspended/failed）→ 生命周期投递（ADR-0031 决策 7：三分支私有）。
  // completed/failed **零 LLM 直投**（同事务终态+brief+简报消息+touch）；suspended → run_suspended + 卡行直读发 hitl_request。
  private publishOutcome(publishTo: string, runId: string, outcome: RunOutcome): void {
    const publish = (frame: Frame) => (publishTo ? this.deps.eventBus.publish(publishTo, frame) : undefined);
    const run = this.deps.runStore.getRun(runId);
    if (outcome.status === "completed") {
      // ADR-0031 决策 4：completed 权威 raw 源 = 引擎 lastOutput（不再从 raw log 末条重派生）；log 仅 stepListFallback 兜底用。
      this.deliverBrief(publish, runId, run, "completed", { lastOutput: outcome.lastOutput, log: this.deps.runStore.getLog(runId), note: undefined });
    } else if (outcome.status === "failed") {
      this.deliverBrief(publish, runId, run, "failed", { log: [], note: outcome.note });
    } else if (outcome.status === "suspended") {
      publish({ type: "run_suspended", runId, stepId: outcome.stepId, questionId: outcome.questionId });
      this.publishAskCard(publish, outcome.questionId);
    }
  }

  // 挂起卡帧（G1：卡已引擎原子直建）：从卡行直读素材（prompt/options/resumeSchema/context）——零重拆 log。
  // questionId 缺/卡已在（畸形产出兜底、headless）→ 只发 run_suspended。
  private publishAskCard(publish: (f: Frame) => void, questionId: number | undefined): void {
    if (questionId === undefined) return;
    const q = this.deps.hitlStore.getQuestion(questionId);
    if (!q) return;
    publish({
      type: "hitl_request", questionId, runId: q.runId, kind: "ask",
      prompt: q.prompt, options: (q.options as string[]) ?? [], resumeSchema: q.resumeSchema,
      ...(q.context !== undefined ? { context: q.context } : {}),
    });
  }

  /**
   * 终态简报投递（ADR-0025 决策 2/3）：setTerminalBrief **同事务**写终态 + brief + 简报消息 + touch +
   * briefMessageId 回填（幂等 guard 在 store 层）→ 推 run_completed(brief, artifacts) + 简报 text 块三帧。
   * 无会话的 run 只写 brief 列不落消息。briefOverride（reconcile 补发用）＝列里真相，跳过重派生。
   */
  private deliverBrief(
    publish: (f: Frame) => void,
    runId: string,
    run: RunRow | undefined,
    terminal: "completed" | "failed",
    src: { log: ReturnType<RunsStore["getLog"]>; lastOutput?: unknown; note: string | undefined; briefOverride?: string },
  ): void {
    if (!run) {
      // 行被删/不存在：仍发边界帧（展示流不受影响），不写库。
      if (terminal === "completed") publish({ type: "run_completed", runId });
      else publish({ type: "run_failed", runId, note: src.note });
      return;
    }
    const lastOut = src.lastOutput ?? src.log[src.log.length - 1]?.output; // 决策 4：completed 优先引擎 lastOutput
    const brief = src.briefOverride ?? (terminal === "completed"
      ? extractBrief(lastOut) ?? stepListFallback(src.log)
      : extractNoteBrief(src.note));
    const artifacts = terminal === "completed" ? extractArtifacts(lastOut) : [];
    const msg = buildBriefMessage({
      workflowId: run.workflowId, terminal, brief, artifacts, workspaceId: run.workspaceId,
    });
    const messageId = this.deps.runStore.setTerminalBrief({
      runId, status: terminal, brief, messageContent: msg, conversationId: run.conversationId,
    });

    if (terminal === "completed") publish({ type: "run_completed", runId, brief, artifacts });
    else publish({ type: "run_failed", runId, note: src.note });
    if (messageId > 0 && run.conversationId) {
      const blockId = `b_brief_${runId}`;
      publish({ type: "block_start", blockId, kind: "text" });
      publish({ type: "block_delta", blockId, delta: msg });
      publish({ type: "block_end", blockId });
    }
  }
}