// run / resume —— run 状态纯由 append-only 日志派生（杀进程续跑天然成立；ADR-0007）。
// **纯**：只接收 ctx.runPi 并用，不 import pi、不装配（装配在 src/runs.ts 组合根）。
import { validate } from "./schema";
import type { RunPiResult, StepContext, StepDef, Workflow } from "./defineWorkflow";
import type { WorkflowStore, RunStatus } from "./store";

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

function loadState(store: WorkflowStore, wf: Workflow, runId: string): Phase {
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

// 执行单步；抛错 → 记 failed 日志 + 置 run failed + 返失败结局（不重抛、不卡 running、可审计）。
// run()/resumeInner() 共用：修「step.execute 抛错 → 状态卡 running、resume 见空/completed 日志当幂等 no-op → 永远不可恢复」。
type ExecResult = { ok: true; result: any } | { ok: false; note: string };
async function execStep(
  store: WorkflowStore, runId: string, stepId: string,
  step: StepDef | undefined, input: unknown, resumed: unknown, ctx: RunCtx,
): Promise<ExecResult> {
  if (!step) {
    store.appendLog(runId, { stepId, status: "failed", input, output: { error: `unknown step ${stepId}` } });
    store.updateRunStatus(runId, "failed");
    return { ok: false, note: `unknown step ${stepId}` };
  }
  try {
    const result = await step.execute(mkCtx({ input }, runId, ctx, resumed));
    return { ok: true, result };
  } catch (e) {
    const note = (e as Error)?.message ?? String(e);
    store.appendLog(runId, { stepId, status: "failed", input, output: { error: note } });
    store.updateRunStatus(runId, "failed");
    return { ok: false, note };
  }
}

export type RunOutcome =
  | { status: "completed"; runId: string }
  | { status: "failed"; runId: string; note?: string }
  | { status: "suspended"; runId: string; stepId: string; payload: unknown; resumeSchema?: unknown };

// run/step 边界进度（ticket #14）：runner 发出，调用方（RunRegistry）整形后推 EventBus。runner 仍纯（只调回调）。
// run_started 由 run() 开头发（#14 规格：engine 发 run_started；run_suspended/completed/failed 由 registry 按 outcome 派生）。
export type RunProgress =
  | { type: "run_started"; workflowId: string }
  | { type: "step_started"; stepId: string }
  | { type: "step_completed"; stepId: string; status: "completed" | "suspended" | "failed"; output?: unknown; payload?: unknown; resumeSchema?: unknown };

export async function run(
  wf: Workflow, store: WorkflowStore, runId: string, ctx: RunCtx,
  onProgress?: (p: RunProgress) => void,
): Promise<RunOutcome> {
  store.updateRunStatus(runId, "running");
  onProgress?.({ type: "run_started", workflowId: wf.id });
  for (;;) {
    const st = loadState(store, wf, runId);
    if (st.phase === "done") {
      store.updateRunStatus(runId, "completed");
      return { status: "completed", runId };
    }
    if (st.phase === "failed") {
      store.updateRunStatus(runId, "failed");
      return { status: "failed", runId, note: st.note };
    }
    if (st.phase === "resume-required") {
      store.updateRunStatus(runId, "suspended");
      return {
        status: "suspended", runId, stepId: st.stepId,
        payload: st.suspendedEntry.suspendPayload,
        resumeSchema: st.suspendedEntry.resumeSchema,
      };
    }
    onProgress?.({ type: "step_started", stepId: st.stepId });
    const r = await execStep(store, runId, st.stepId, wf.steps[st.stepId], st.input, undefined, ctx);
    if (!r.ok) {
      onProgress?.({ type: "step_completed", stepId: st.stepId, status: "failed" });
      return { status: "failed", runId, note: r.note };
    }
    const result = r.result;
    if (result && typeof result === "object" && "__suspend" in (result as any)) {
      const sus = (result as any).__suspend;
      store.appendLog(runId, {
        stepId: st.stepId, status: "suspended", input: st.input,
        suspendPayload: sus.payload, resumeSchema: sus.resumeSchema,
      });
      store.updateRunStatus(runId, "suspended");
      onProgress?.({ type: "step_completed", stepId: st.stepId, status: "suspended", payload: sus.payload, resumeSchema: sus.resumeSchema });
      return { status: "suspended", runId, stepId: st.stepId, payload: sus.payload };
    }
    store.appendLog(runId, { stepId: st.stepId, status: "completed", input: st.input, output: result });
    onProgress?.({ type: "step_completed", stepId: st.stepId, status: "completed", output: result });
  }
}

export type ResumeOutcome =
  | RunOutcome
  | { status: "suspended"; runId: string; rejected: true; error: string }
  | { status: RunStatus; runId: string; idempotent: true; note: string };

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
  wf: Workflow, store: WorkflowStore, runId: string, resumeData: unknown, ctx: RunCtx,
  onProgress?: (p: RunProgress) => void,
): Promise<ResumeOutcome> {
  const log = store.getLog(runId);
  const last = log[log.length - 1];

  // 幂等：当前未挂起 → 不动状态，返回当前。
  if (!last || last.status !== "suspended") {
    const r = store.getRun(runId);
    return { status: (r?.status ?? "failed") as RunStatus, runId, idempotent: true, note: "not currently suspended" };
  }

  // 校验续跑数据 —— 失败则拒，不改状态。
  const v = validate(last.resumeSchema as any, resumeData);
  if (!v.ok) return { status: "suspended", runId, rejected: true, error: v.error };

  onProgress?.({ type: "step_started", stepId: last.stepId });
  const r = await execStep(store, runId, last.stepId, wf.steps[last.stepId], last.input, resumeData, ctx);
  if (!r.ok) {
    onProgress?.({ type: "step_completed", stepId: last.stepId, status: "failed" });
    return { status: "failed", runId, note: r.note };
  }
  const result = r.result;

  if (result && typeof result === "object" && "__suspend" in (result as any)) {
    const sus = (result as any).__suspend;
    store.appendLog(runId, {
      stepId: last.stepId, status: "suspended", input: last.input,
      suspendPayload: sus.payload, resumeSchema: sus.resumeSchema, resumeData,
    });
    store.updateRunStatus(runId, "suspended");
    onProgress?.({ type: "step_completed", stepId: last.stepId, status: "suspended", payload: sus.payload, resumeSchema: sus.resumeSchema });
    return { status: "suspended", runId, stepId: last.stepId, payload: sus.payload };
  }

  store.appendLog(runId, { stepId: last.stepId, status: "completed", input: last.input, output: result, resumeData });
  onProgress?.({ type: "step_completed", stepId: last.stepId, status: "completed", output: result });
  return run(wf, store, runId, ctx, onProgress);
}

export async function resume(
  wf: Workflow, store: WorkflowStore, runId: string, resumeData: unknown, ctx: RunCtx,
  onProgress?: (p: RunProgress) => void,
): Promise<ResumeOutcome> {
  return withResumeLock(runId, () => resumeInner(wf, store, runId, resumeData, ctx, onProgress));
}
