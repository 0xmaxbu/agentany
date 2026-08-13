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
import type { WorkflowStore } from "../workflow-engine/store";
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
  runPiFactory?: (opts: { extensions?: string[]; scope: Scope; projectId: string | null; sessionId: string }) => ConfiguredRunPi;
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
    const projectId = conv.projectId; // 可空
    const scope = scopeOf(projectId);

    const runId = makeRunId();
    this.deps.store.createRun({ runId, workflowId: p.workflowId, projectId, conversationId: p.conversationId, input: p.input });

    const abortCtrl = new AbortController();
    const ctx = this.ctxFor(wf, scope, projectId, runId, abortCtrl);
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

  /** 续跑（#16 HITL 经 bridge 调）。重建 ctx（句柄可能因重启不在）。rejected/idempotent 不发 run_*。 */
  async resume(runId: string, resumeData: unknown): Promise<ResumeOutcome> {
    const row = this.deps.store.getRun(runId);
    if (!row) throw new Error(`run not found: ${runId}`);
    const wf = getWorkflow(row.workflowId);
    if (!wf) throw new WorkflowNotFound(row.workflowId);
    const conv = row.conversationId ? this.deps.store.getConversation(row.conversationId) : undefined;
    const projectId = conv?.projectId ?? row.projectId ?? null;
    const scope = scopeOf(projectId);
    const abortCtrl = this.handles.get(runId)?.abortCtrl ?? new AbortController();
    const ctx = this.ctxFor(wf, scope, projectId, runId, abortCtrl);
    const publish = (frame: Frame) => {
      if (row.conversationId) this.deps.eventBus.publish(row.conversationId, frame);
    };
    const onProgress = (p: RunProgress) => publish({ ...p, runId });
    publish({ type: "run_resumed", runId });
    const outcome = await resume(wf, this.deps.store, runId, resumeData, ctx, onProgress);
    // rejected / idempotent 不是 clean 结局，不发 run_*（由调用方处理）。
    if (!("rejected" in outcome) && !("idempotent" in outcome)) {
      this.publishOutcome(publish, runId, outcome);
    }
    return outcome;
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
      latestOutput: last?.output ?? null,
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
        h.abortCtrl.abort(); // runDetached catch 发一次 run_failed（不重复）
      } else {
        this.deps.store.updateRunStatus(runId, "failed");
        this.deps.eventBus.publish(conversationId, { type: "run_failed", runId, note: "aborted (no handle)" });
      }
    }
    return ids.length;
  }

  // —— 内部 ——
  private ctxFor(wf: Workflow, scope: Scope, projectId: string | null, runId: string, abortCtrl: AbortController): RunCtx {
    const factory = this.deps.runPiFactory ?? makeRunPi;
    const { cwd } = resolveScopePaths(scope, projectId);
    const runPi = factory({ extensions: wf.extensions, scope, projectId, sessionId: `run-${runId}` });
    return { runPi, projectId: projectId ?? "", cwd, signal: abortCtrl.signal, log: () => {} };
  }

  private async runDetached(runId: string, conversationId: string, wf: Workflow, ctx: RunCtx): Promise<RunOutcome> {
    const publish = (frame: Frame) => this.deps.eventBus.publish(conversationId, frame);
    const onProgress = (p: RunProgress) => publish({ ...p, runId }); // run_started 由 run() 发、经此透传（带 runId）
    let outcome: RunOutcome;
    try {
      outcome = await run(wf, this.deps.store, runId, ctx, onProgress);
    } catch (e) {
      const note = (e as Error)?.message ?? String(e);
      this.deps.store.updateRunStatus(runId, "failed");
      publish({ type: "run_failed", runId, note });
      return { status: "failed", runId, note };
    }
    this.publishOutcome(publish, runId, outcome);
    return outcome;
  }

  // outcome（clean 结局：completed/suspended/failed）→ run_* 帧推 EventBus。rejected/idempotent 调用方自理。
  private publishOutcome(publish: (f: Frame) => void, runId: string, outcome: RunOutcome): void {
    if (outcome.status === "completed") publish({ type: "run_completed", runId });
    else if (outcome.status === "suspended") publish({ type: "run_suspended", runId, stepId: outcome.stepId, payload: outcome.payload, resumeSchema: outcome.resumeSchema });
    else publish({ type: "run_failed", runId, note: outcome.note });
  }
}
