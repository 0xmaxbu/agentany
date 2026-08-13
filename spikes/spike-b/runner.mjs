// spikes/spike-b/runner.mjs — run / resume。
// 核心：run 状态完全由 append-only 日志派生（loadState）→ 杀进程后续跑天然成立（盘上日志在）。
// suspend/resume = replay-free 两相：首跑返回 __suspend（须廉价无副作用），resume 重执行同一步、ctx.resumed=resumeData。
import { validate } from "./schema.mjs";

// 从日志派生「现在该干什么」。无任何内存态。
function loadState(store, workflow, runId) {
  const run = store.getRun(runId);
  const log = store.getLog(runId);

  if (log.length === 0)
    return { run, log, phase: "execute", stepId: workflow.start, input: run.input, resumed: undefined };

  const last = log[log.length - 1];

  if (last.status === "suspended")
    return { run, log, phase: "resume-required", stepId: last.stepId, suspendedEntry: last };

  if (last.status === "completed") {
    const out = last.output;
    const next = (out && out.__next) || workflow.defaultNext(last.stepId);
    if (!next) return { run, log, phase: "done" };
    return { run, log, phase: "execute", stepId: next, input: out, resumed: undefined };
  }

  // running / failed（崩溃残留或显式失败）—— spike 不做崩溃恢复，按 failed 报
  return { run, log, phase: "failed", note: `unfinished log tail status=${last.status}` };
}

// 推进到下一个 suspend / done。每个步执行后 append 一条日志，循环再 loadState。
export async function run(workflow, store, runId, ctx) {
  store.updateRunStatus(runId, "running");
  for (;;) {
    const st = loadState(store, workflow, runId);

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

    // execute
    const step = workflow.steps[st.stepId];
    if (!step) {
      store.updateRunStatus(runId, "failed");
      return { status: "failed", runId, note: `unknown step ${st.stepId}` };
    }
    const result = await step.execute({
      input: st.input, resumed: undefined,
      runPi: ctx.runPi, projectId: ctx.projectId, runId,
      signal: ctx.signal, log: ctx.log,
    });

    if (result && result.__suspend) {
      store.appendLog(runId, {
        stepId: st.stepId, status: "suspended",
        input: st.input,
        suspendPayload: result.__suspend.payload,
        resumeSchema: result.__suspend.resumeSchema,
      });
      store.updateRunStatus(runId, "suspended");
      return { status: "suspended", runId, stepId: st.stepId, payload: result.__suspend.payload };
    }

    store.appendLog(runId, { stepId: st.stepId, status: "completed", input: st.input, output: result });
    // loop：loadState 会看到新的 completed 条目，按 __next/defaultNext 推进
  }
}

// 续跑：校验 resumeData → 重执行被挂起的步（ctx.resumed）→ 续推。
export async function resume(workflow, store, runId, resumeData, ctx) {
  const log = store.getLog(runId);
  const last = log[log.length - 1];

  // 幂等：当前未挂起（已续过 / 未开始 / 已终结）→ 不动状态，返回当前
  if (!last || last.status !== "suspended") {
    const r = store.getRun(runId);
    return { status: r.status, runId, idempotent: true, note: "not currently suspended" };
  }

  // 校验续跑数据 —— 失败则拒，不改任何状态（不 append）
  const v = validate(last.resumeSchema, resumeData);
  if (!v.ok) return { status: "suspended", runId, rejected: true, error: v.error };

  const step = workflow.steps[last.stepId];
  const result = await step.execute({
    input: last.input, resumed: resumeData,
    runPi: ctx.runPi, projectId: ctx.projectId, runId,
    signal: ctx.signal, log: ctx.log,
  });

  if (result && result.__suspend) {
    // 再次挂起（多轮 HITL，spike 不测但允许）
    store.appendLog(runId, {
      stepId: last.stepId, status: "suspended",
      input: last.input,
      suspendPayload: result.__suspend.payload,
      resumeSchema: result.__suspend.resumeSchema,
      resumeData,
    });
    store.updateRunStatus(runId, "suspended");
    return { status: "suspended", runId, stepId: last.stepId, payload: result.__suspend.payload };
  }

  store.appendLog(runId, { stepId: last.stepId, status: "completed", input: last.input, output: result, resumeData });
  // 续跑后从这条 completed 继续推进到下一个 suspend / done
  return run(workflow, store, runId, ctx);
}
