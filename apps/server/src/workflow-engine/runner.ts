// run / resume —— run 状态纯由 append-only 日志派生（杀进程续跑天然成立；ADR-0007）。
// **纯**：只接收 ctx.runPi 并用，不 import pi、不装配（装配在 src/runs.ts 组合根）。
// ADR-0031（#68/A2）：
// - G1 原子挂起：挂起点直接调 RunsStore.suspendedStep（log+status+ask 卡同一事务）——ADR-0025 决策 6 字面落实，
//   孤儿窗口归零；RunOutcome.suspended = 纯类型 {runId, stepId, questionId}（deliverAskCard 退役）。
// - verdictOf 单一裁决源：lifecycle 同步预检与 resumeInner 权威判定同源（双 verdict 机器合一）。
// - 引擎诚实化：顶层 catch-all → failed（永不越过状态机抛出）；status 单写者（appendStep/suspendedStep/setTerminalBrief）。
import { validate } from "./schema";
import type { RunPiResult, StepContext, StepDef, Workflow } from "./defineWorkflow";
import type { RunsStore, RunStatus } from "../runs/store"; // ADR-0030 决策 6：引擎只学 runs 面

export interface RunCtx {
  runPi: (opts: { prompt: string; timeoutMs?: number }) => Promise<RunPiResult>;
  workspaceId: string;
  cwd: string;
  signal: AbortSignal;
  log: (...args: unknown[]) => void;
}

type Phase =
  | { phase: "execute"; stepId: string; input: unknown }
  | { phase: "resume-required"; stepId: string; suspendedEntry: any }
  | { phase: "done" }
  | { phase: "failed"; note?: string };

function loadState(store: RunsStore, wf: Workflow, runId: string): Phase {
  const run = store.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  const log = store.getLog(runId);

  if (log.length === 0)
    return { phase: "execute", stepId: wf.start, input: run.input };

  const last = log[log.length - 1];
  if (last.status === "suspended")
    return { phase: "resume-required", stepId: last.stepId, suspendedEntry: last };

  if (last.status === "completed") {
    const out: any = last.output;
    const next = (out && out.__next) || wf.defaultNext(last.stepId);
    if (!next) return { phase: "done" };
    return { phase: "execute", stepId: next, input: out };
  }

  // running / failed（崩溃残留或失败）—— spike 不做崩溃恢复，按 failed 报。
  return { phase: "failed", note: `unfinished log tail status=${last.status}` };
}

function mkCtx(st: { input: unknown }, runId: string, ctx: RunCtx, resumed: unknown): StepContext {
  return {
    input: st.input,
    resumed,
    runPi: ctx.runPi,
    workspaceId: ctx.workspaceId,
    runId,
    cwd: ctx.cwd,
    signal: ctx.signal,
    log: ctx.log,
  };
}

// 执行单步；抛错 → appendStep（失败日志 + status=failed 同一事务）+ 返失败结局。
// run()/resumeInner() 共用：修「step.execute 抛错 → 状态卡 running、resume 见空/completed 日志当幂等 no-op → 永远不可恢复」。
type ExecResult = { ok: true; result: any } | { ok: false; note: string };
async function execStep(
  store: RunsStore, runId: string, stepId: string,
  step: StepDef | undefined, input: unknown, resumed: unknown, ctx: RunCtx,
): Promise<ExecResult> {
  if (!step) {
    store.appendStep(runId, { stepId, status: "failed", input, output: { error: `unknown step ${stepId}` }, runStatus: "failed" });
    return { ok: false, note: `unknown step ${stepId}` };
  }
  try {
    const result = await step.execute(mkCtx({ input }, runId, ctx, resumed));
    return { ok: true, result };
  } catch (e) {
    const note = (e as Error)?.message ?? String(e);
    store.appendStep(runId, { stepId, status: "failed", input, output: { error: note }, runStatus: "failed" });
    return { ok: false, note };
  }
}

export type RunOutcome =
  | { status: "completed"; runId: string; lastOutput?: unknown } // A2：带 lastOutput（终态投递 raw 源，不重读 log）
  | { status: "failed"; runId: string; note?: string }
  // A2（G1）：纯类型——卡已引擎原子直建（questionId）；畸形产出/无会话 → 兜底无卡（questionId 缺）
  | { status: "suspended"; runId: string; stepId: string; questionId?: number };

// run/step 边界进度（ticket #14）：runner 发出，调用方（RunLifecycle）整形后推 EventBus。runner 仍纯（只调回调）。
// run_started 由 run() 开头发（#14 规格：engine 发 run_started；run_suspended/completed/failed 由 lifecycle 按 outcome 派生）。
export type RunProgress =
  | { type: "run_started"; workflowId: string }
  | { type: "step_started"; stepId: string }
  | { type: "step_completed"; stepId: string; status: "completed" | "suspended" | "failed"; output?: unknown; payload?: unknown; resumeSchema?: unknown };

/**
 * 续跑裁决单源（ADR-0031 决策 3）：run 存在 + 挂起态 + resumeSchema 校验 → running｜rejected｜idempotent。
 * lifecycle 同步预检与 resumeInner 权威判定共用——两套 verdict 状态机合一。不发帧、不动状态。
 */
export type ResumeVerdict =
  | { kind: "running" }
  | { kind: "rejected"; error: string }
  | { kind: "idempotent"; status: RunStatus };

export function verdictOf(store: RunsStore, runId: string, resumeData: unknown): ResumeVerdict {
  const log = store.getLog(runId);
  const last = log[log.length - 1];
  if (!last || last.status !== "suspended") {
    const r = store.getRun(runId);
    return { kind: "idempotent", status: r?.status ?? "failed" };
  }
  const v = validate(last.resumeSchema as any, resumeData);
  if (!v.ok) return { kind: "rejected", error: v.error };
  return { kind: "running" };
}

/**
 * 挂起点统一（G1/ADR-0025 决策 6）：step 产出 __suspend 且 payload 带问句 + run 绑会话
 * → suspendedStep 原子直建卡（log+status+卡同一事务）；畸形产出（无 question）/无会话（headless）→
 * appendStep(suspended) 兜底（无卡；续跑由 [挂起工作流] 注入 + resume_workflow）。
 * resumeData 仅在续跑再挂时入 log（首挂无答案）。
 */
function suspendRun(
  store: RunsStore, runId: string, stepId: string, input: unknown,
  sus: { payload?: unknown; resumeSchema?: unknown }, resumeData?: unknown,
): { stepId: string; questionId?: number } {
  const payload = sus.payload as { question?: string; options?: unknown[]; context?: unknown } | null | undefined;
  const run = store.getRun(runId);
  const hasAsk = typeof payload?.question === "string" && !!run?.conversationId;
  if (hasAsk) {
    const questionId = store.suspendedStep({
      runId, stepId, input,
      suspendPayload: sus.payload, resumeSchema: sus.resumeSchema,
      conversationId: run!.conversationId!,
      values: Array.isArray(payload!.options) ? (payload!.options as { label: string; value: unknown }[]) : [],
      resumeData,
    });
    return { stepId, questionId };
  }
  store.appendStep(runId, {
    stepId, status: "suspended", input,
    suspendPayload: sus.payload, resumeSchema: sus.resumeSchema, resumeData, runStatus: "suspended",
  });
  return { stepId };
}

export async function run(
  wf: Workflow, store: RunsStore, runId: string, ctx: RunCtx,
  onProgress?: (p: RunProgress) => void,
): Promise<RunOutcome> {
  try {
    onProgress?.({ type: "run_started", workflowId: wf.id });
    let lastOutput: unknown; // done 时带出（终态投递 raw 源）
    for (;;) {
      const st = loadState(store, wf, runId);
      if (st.phase === "done") return { status: "completed", runId, lastOutput };
      if (st.phase === "failed") return { status: "failed", runId, note: st.note };
      if (st.phase === "resume-required") {
        // 对已挂起 run 调 run()（Lifecycle.start 不应触达；防御）：卡已存（首挂原子建/畸形兜底无卡）
        return { status: "suspended", runId, stepId: st.stepId };
      }
      onProgress?.({ type: "step_started", stepId: st.stepId });
      const r = await execStep(store, runId, st.stepId, wf.steps[st.stepId], st.input, undefined, ctx);
      if (!r.ok) {
        onProgress?.({ type: "step_completed", stepId: st.stepId, status: "failed" });
        return { status: "failed", runId, note: r.note };
      }
      const result = r.result;
      if (result && typeof result === "object" && "__suspend" in (result as any)) {
        const s = suspendRun(store, runId, st.stepId, st.input, (result as any).__suspend);
        onProgress?.({ type: "step_completed", stepId: st.stepId, status: "suspended", payload: (result as any).__suspend.payload, resumeSchema: (result as any).__suspend.resumeSchema });
        return { status: "suspended", runId, stepId: s.stepId, questionId: s.questionId };
      }
      store.appendStep(runId, { stepId: st.stepId, status: "completed", input: st.input, output: result });
      lastOutput = result;
      onProgress?.({ type: "step_completed", stepId: st.stepId, status: "completed", output: result });
    }
  } catch (e) {
    // 引擎顶层 catch-all（ADR-0031 决策 4）：永不越过状态机抛出——调用方 catch 路径与 status 双写消失。
    const note = (e as Error)?.message ?? String(e);
    return { status: "failed", runId, note };
  }
}

export type ResumeOutcome =
  | RunOutcome
  | { status: "suspended"; runId: string; rejected: true; error: string }
  | { status: RunStatus; runId: string; idempotent: true; note: string }
  | { status: "running"; runId: string }; // A2：lifecycle.resume 同步 verdict——clean 已接受，续跑 detached

// h7：per-runId 串行锁。把 resume 的 check-then-act 串行化，防并发 resume 双执行（TOCTOU）。
// 单进程（ADR-0003）下内存锁足够；第一个跑完后第二个再见 advanced 状态→幂等。
const resumeLocks = new Map<string, Promise<unknown>>();
async function withResumeLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const prev = resumeLocks.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  resumeLocks.set(runId, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (resumeLocks.get(runId) === next) resumeLocks.delete(runId); // 无后续等待者则清理
  }
}

async function resumeInner(
  wf: Workflow, store: RunsStore, runId: string, resumeData: unknown, ctx: RunCtx,
  onProgress?: (p: RunProgress) => void,
): Promise<ResumeOutcome> {
  try {
    // 单一裁决源（决策 3）：idempotent/rejected 不改状态；running 才执行续跑步。
    const v = verdictOf(store, runId, resumeData);
    if (v.kind === "idempotent") return { status: v.status, runId, idempotent: true, note: "not currently suspended" };
    if (v.kind === "rejected") return { status: "suspended", runId, rejected: true, error: v.error };

    const log = store.getLog(runId);
    const last = log[log.length - 1]; // verdict running ⇒ tail 必 suspended
    onProgress?.({ type: "step_started", stepId: last.stepId });
    const r = await execStep(store, runId, last.stepId, wf.steps[last.stepId], last.input, resumeData, ctx);
    if (!r.ok) {
      onProgress?.({ type: "step_completed", stepId: last.stepId, status: "failed" });
      return { status: "failed", runId, note: r.note };
    }
    const result = r.result;

    if (result && typeof result === "object" && "__suspend" in (result as any)) {
      const sus = (result as any).__suspend;
      // 二次挂起：resumeSchema 经 suspendedStep 落 log+卡（修旧 runner.ts:196 首挂 outcome 漏 resumeSchema）
      const s = suspendRun(store, runId, last.stepId, last.input, sus, resumeData);
      onProgress?.({ type: "step_completed", stepId: last.stepId, status: "suspended", payload: sus.payload, resumeSchema: sus.resumeSchema });
      return { status: "suspended", runId, stepId: s.stepId, questionId: s.questionId };
    }

    store.appendStep(runId, { stepId: last.stepId, status: "completed", input: last.input, output: result, resumeData });
    onProgress?.({ type: "step_completed", stepId: last.stepId, status: "completed", output: result });
    return run(wf, store, runId, ctx, onProgress);
  } catch (e) {
    const note = (e as Error)?.message ?? String(e);
    return { status: "failed", runId, note };
  }
}

export async function resume(
  wf: Workflow, store: RunsStore, runId: string, resumeData: unknown, ctx: RunCtx,
  onProgress?: (p: RunProgress) => void,
): Promise<ResumeOutcome> {
  return withResumeLock(runId, () => resumeInner(wf, store, runId, resumeData, ctx, onProgress));
}