// RunRegistry（ticket #14）：异步工作流 run 的句柄统一处（start / resume / abort / read 经此）。
// - start：校验 → createRun(DB) → 注册内存句柄 → fire 后台 detached runner.run → 立即返 {running, runId}。
//   run 不绑 turn：start 返回后 turn 结束、run 续跑。
// - 进度：runner onProgress（step_started/step_completed）+ run 边界（run_started/completed/suspended/failed）
//   → EventBus 推该会话持久流（step_* 仅展示；run_* 驱动 turn 在 #15 接）。
// - DB 为真相；内存句柄重启即失。boot sweepCrashed 把 DB 里仍 running 的 run 标 failed。
// run 的 scope/cwd 取自【会话】（general 会话 → general workspace）；makeRunPi scope-aware。
import { run, resume, type RunCtx, type RunProgress, type RunOutcome, type ResumeOutcome } from "../workflow-engine/runner";
import { getWorkflow } from "../registry";
import { makeRunPi, type ConfiguredRunPi } from "../pi/runPi-factory";
import { resolveScopePaths, scopeOf, type Scope } from "../scope";
import { validate } from "../workflow-engine/schema";
import { decide } from "../security/policy";
import { buildBriefMessage, extractArtifacts, extractBrief, extractNoteBrief, stepListFallback, truncateForRead } from "./briefing";
import type { WorkflowStore, RunRow, RunStatus } from "../workflow-engine/store";
import type { Workflow } from "../workflow-engine/defineWorkflow";
import type { EventBus, Frame } from "../chat/eventbus";
import { WorkflowNotFound, InvalidInput, makeRunId } from "../runs";

// 句柄只留「运行期需要、DB 没有」的：abort 控制器 + scope/session（resume 重建 ctx 用）。
// 状态走 DB（ADR-0007：进程无内存态）——不存 status（曾只写不读）/ promise（曾存从不 await）→ 死字段已删。
export interface RunHandle {
  conversationId: string;
  scope: Scope;
  sessionId: string;
  abortCtrl: AbortController;
}

export interface RunRegistryDeps {
  store: WorkflowStore;
  eventBus: EventBus;
  runPiFactory?: (opts: { extensions?: string[]; scope: Scope; workspaceId: string | null; sessionId: string }) => ConfiguredRunPi;
}

// #18 审批门：start 的三态出口。allow→running；deny→拒（当前 POSTURES 下对已注册工作流不可达，防御）；
// require_approval→建审批卡、不 createRun。approved flag（仅 /approvals/decide 内部用）跳 policy 直跑。
export type StartOutcome =
  | { runId: string; status: "running" }
  | { status: "denied"; reason: string }
  | { status: "needs_approval"; questionId: number };

export class RunRegistry {
  private handles = new Map<string, RunHandle>();

  constructor(private deps: RunRegistryDeps) {}

  /** 启动异步 run（chat 经 bridge 调）。立即返 StartOutcome（running/denied/needs_approval）；run 后台 detached。 */
  start(p: { conversationId: string; workflowId: string; input: unknown; approved?: boolean }): StartOutcome {
    const wf = getWorkflow(p.workflowId);
    if (!wf) throw new WorkflowNotFound(p.workflowId);
    const v = validate(wf.inputSchema as any, p.input);
    if (!v.ok) throw new InvalidInput(v.error);

    // #18 审批门（窄口径）：未经 approved → 按 CommandPolicy 判。validate 已过，故审批卡只为合法 input 弹。
    if (!p.approved) {
      const verdict = decide(p.workflowId);
      if (verdict.decision === "deny") return { status: "denied", reason: verdict.reason };
      if (verdict.decision === "require_approval") {
        return this.requireApproval(p, wf);
      }
    }

    const conv = this.deps.store.getConversation(p.conversationId);
    if (!conv) throw new Error(`conversation not found: ${p.conversationId}`);
    const workspaceId = conv.workspaceId;
    const scope = scopeOf(workspaceId);

    const runId = makeRunId();
    this.deps.store.createRun({ runId, workflowId: p.workflowId, workspaceId, conversationId: p.conversationId, input: p.input });

    const abortCtrl = new AbortController();
    const ctx = this.ctxFor(wf, scope, workspaceId, runId, abortCtrl);
    this.handles.set(runId, { conversationId: p.conversationId, scope, sessionId: `run-${runId}`, abortCtrl });
    void this.runDetached(runId, p.conversationId, wf, ctx); // detached：fire-and-forget（状态经 DB + EventBus 推流，不持 promise）
    return { runId, status: "running" };
  }

  /** #18 require_approval 出口：幂等建审批卡（同 conv+workflow 已有 pending → 复用）+ 发 hitl_request；不 createRun。 */
  private requireApproval(p: { conversationId: string; workflowId: string; input: unknown }, wf: Workflow): StartOutcome {
    const prompt = `启动工作流「${wf.name ?? p.workflowId}」需审批`;
    const options = ["批准", "拒绝"];
    const existing = this.deps.store.getPendingApproval(p.conversationId, p.workflowId);
    if (existing) return { status: "needs_approval", questionId: existing.id }; // 幂等：防 pi 重调堆卡
    const questionId = this.deps.store.createQuestion({
      conversationId: p.conversationId, runId: null, kind: "approval",
      workflowId: p.workflowId, input: p.input, prompt, options,
    });
    this.deps.eventBus.publish(p.conversationId, {
      type: "hitl_request", questionId, runId: null, kind: "approval",
      workflowId: p.workflowId, prompt, options,
    });
    return { status: "needs_approval", questionId };
  }

  /** 续跑（#16 HITL 经 bridge 调；ADR-0025 决策 11 拆分）。
   *  同步段只判 verdict 即时返（rejected/idempotent/clean→running）；clean → detached 续跑（对齐 start 语义，
   *  不再阻塞 HTTP 分钟级）。续跑帧经 DB + EventBus；双击幂等由 runner 串行锁承担（第二次 idempotent 静默）。 */
  async resume(runId: string, resumeData: unknown): Promise<ResumeOutcome> {
    const row = this.deps.store.getRun(runId);
    if (!row) throw new Error(`run not found: ${runId}`);
    const verdict = this.resumeVerdict(runId, resumeData);
    if (verdict.kind === "rejected") return { status: "suspended", runId, rejected: true, error: verdict.error };
    if (verdict.kind === "idempotent") return { status: verdict.status, runId, idempotent: true, note: "not currently suspended" };
    const wf = getWorkflow(row.workflowId);
    if (!wf) throw new WorkflowNotFound(row.workflowId);
    this.resumeDetached(wf, row, runId, resumeData); // fire-and-forget；ctx 在其内构建（verdict 保持纯同步零开销）
    return { status: "running", runId }; // clean 即时 verdict；续跑后台 detached
  }

  // 同步段：run 存在（调用方已取）+ 挂起态 + resumeSchema 校验 → running｜rejected｜idempotent。不发帧、不动状态。
  // 校验与 runner 内 resumeInner 同口径（validate(last.resumeSchema)）——廉价先行，err 面调用方即时可判。
  private resumeVerdict(runId: string, resumeData: unknown):
    | { kind: "running" }
    | { kind: "rejected"; error: string }
    | { kind: "idempotent"; status: RunStatus } {
    const log = this.deps.store.getLog(runId);
    const last = log[log.length - 1];
    if (!last || last.status !== "suspended") {
      const r = this.deps.store.getRun(runId);
      return { kind: "idempotent", status: r?.status ?? "failed" };
    }
    const v = validate(last.resumeSchema as any, resumeData);
    if (!v.ok) return { kind: "rejected", error: v.error };
    return { kind: "running" };
  }

  // detached 续跑：重建 ctx（句柄可能因重启不在）；rejected/idempotent 不发 run_*（幂等对竞态双击，
  // rejected 已在同步段挡掉走不到这）。run_resumed 补发在续跑真成立后（ADR-0022：不预发）。
  private resumeDetached(wf: Workflow, row: RunRow, runId: string, resumeData: unknown): void {
    const publish = (frame: Frame) => {
      if (row.conversationId) this.deps.eventBus.publish(row.conversationId, frame);
    };
    const onProgress = (p: RunProgress) => publish({ ...p, runId });
    void (async () => {
      const abortCtrl = this.handles.get(runId)?.abortCtrl ?? new AbortController();
      const ctx = this.ctxFor(wf, scopeOf(row.workspaceId), row.workspaceId, runId, abortCtrl);
      let outcome: ResumeOutcome;
      try {
        outcome = await resume(wf, this.deps.store, runId, resumeData, ctx, onProgress);
      } catch (e) {
        const note = (e as Error)?.message ?? String(e); // 顶抛：标 failed + 推 run_failed（同 runDetached catch）
        this.deps.store.updateRunStatus(runId, "failed");
        publish({ type: "run_failed", runId, note });
        return;
      }
      if (!("rejected" in outcome) && !("idempotent" in outcome)) {
        publish({ type: "run_resumed", runId }); // 真续跑成立才补发（步骤帧已先行——顺序仅影响展示，终值正确）
        // runner.resume 只产 RunOutcome|rejected|idempotent（running 仅 registry 同步段产）；窄化断言
        this.publishOutcome(publish, runId, outcome as RunOutcome);
      }
    })();
  }

  /** 读 run 状态/步骤/最新输出（chat read_run 经 bridge 调）。 */
  read(runId: string): { runId: string; status: string; steps: { seq: number; stepId: string; status: string }[]; latestOutput: unknown } | null {
    const r = this.deps.store.getRun(runId);
    if (!r) return null;
    const log = this.deps.store.getLog(runId);
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

  /** boot 调：DB 里仍 running 的 run 标 failed（重启=进程没在跑了；v1 假设步幂等）。返处理数。 */
  sweepCrashed(): number {
    return this.deps.store.markRunningAsFailed();
  }

  /** #19 abort：停该会话所有 running run。有句柄→abortCtrl.abort()（杀 pi → runDetached catch 自负 status+publish run_failed，单次）；无句柄（重启 stale）→直接 failed+publish。返停数。 */
  stopConversationRuns(conversationId: string): number {
    const ids = this.deps.store.listRunningRunIds(conversationId);
    for (const runId of ids) {
      const h = this.handles.get(runId);
      if (h) {
        h.abortCtrl.abort(); // runDetached catch → publishOutcome(failed) 发一次 run_failed + 简报（不重复）
      } else {
        // 无句柄（重启 stale）：直接 failed + 投递（终态简报同通道——abort note 即简报）
        this.publishOutcome((f) => this.deps.eventBus.publish(conversationId, f), runId, {
          status: "failed", runId, note: "aborted (no handle)",
        });
      }
    }
    return ids.length;
  }

  // —— 内部 ——
  private ctxFor(wf: Workflow, scope: Scope, workspaceId: string, runId: string, abortCtrl: AbortController): RunCtx {
    const factory = this.deps.runPiFactory ?? makeRunPi;
    const { cwd } = resolveScopePaths(scope, workspaceId);
    const runPi = factory({ extensions: wf.extensions, scope, workspaceId: workspaceId, sessionId: `run-${runId}` });
    return { runPi, workspaceId, cwd, signal: abortCtrl.signal, log: () => {} };
  }

  private async runDetached(runId: string, conversationId: string, wf: Workflow, ctx: RunCtx): Promise<RunOutcome> {
    const publish = (frame: Frame) => this.deps.eventBus.publish(conversationId, frame);
    const onProgress = (p: RunProgress) => publish({ ...p, runId }); // run_started 由 run() 发、经此透传（带 runId）
    let outcome: RunOutcome;
    try {
      outcome = await run(wf, this.deps.store, runId, ctx, onProgress);
    } catch (e) {
      const note = (e as Error)?.message ?? String(e);
      outcome = { status: "failed", runId, note }; // 顶抛（loadState 等）→ 同走 publishOutcome（终态简报统一）
    }
    this.publishOutcome(publish, runId, outcome);
    return outcome;
  }

  // outcome（clean 结局：completed/suspended/failed）→ 生命周期投递。
  // ADR-0025（#41/T1）：completed/failed **零 LLM 直投**——同事务写终态+brief+简报消息+touch，
  // 回填 brief_message_id → 发 run_completed(brief, artifacts) + 简报 text 块（无 done——非轮）。suspended 由 T3 接。
  private publishOutcome(publish: (f: Frame) => void, runId: string, outcome: RunOutcome): void {
    const run = this.deps.store.getRun(runId);
    if (outcome.status === "completed") {
      this.deliverBrief(publish, runId, run, "completed", { log: this.deps.store.getLog(runId), note: undefined });
    } else if (outcome.status === "failed") {
      this.deliverBrief(publish, runId, run, "failed", { log: [], note: outcome.note });
    } else {
      publish({ type: "run_suspended", runId, stepId: outcome.stepId, payload: outcome.payload, resumeSchema: outcome.resumeSchema });
    }
  }

  /**
   * 终态简报投递（ADR-0025 决策 2/3）：同事务写 brief + 简报消息 + touch（setTerminalBrief）→
   * 回填 brief_message_id → 推 run_completed(brief, artifacts) + 简报 text 块三帧
   * （block_start/delta/end，无 done——非轮；内容 linkify）。无会话的 run 只写 brief 列不落消息。
   */
  private deliverBrief(
    publish: (f: Frame) => void,
    runId: string,
    run: RunRow | undefined,
    terminal: "completed" | "failed",
    src: { log: ReturnType<WorkflowStore["getLog"]>; note: string | undefined },
  ): void {
    if (!run) {
      // 行被删/不存在：仍发边界帧（展示流不受影响），不写库。
      if (terminal === "completed") publish({ type: "run_completed", runId });
      else publish({ type: "run_failed", runId, note: src.note });
      return;
    }
    const last = src.log[src.log.length - 1];
    const brief = terminal === "completed"
      ? extractBrief(last?.output) ?? stepListFallback(src.log)
      : extractNoteBrief(src.note);
    const artifacts = terminal === "completed" ? extractArtifacts(last?.output) : [];
    const msg = buildBriefMessage({
      workflowId: run.workflowId, terminal, brief, artifacts, workspaceId: run.workspaceId,
    });
    const messageId = this.deps.store.setTerminalBrief({
      runId, status: terminal, brief, messageContent: msg, conversationId: run.conversationId,
    });
    this.deps.store.backfillBriefMessage(runId, messageId > 0 ? messageId : null);

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
