// spikes/spike-b/driver.mjs — CLI 子命令，每个调用=独立进程（供「杀进程续跑」跨进程验证）。
// 用法：bun run driver.mjs <dbPath> <cmd> ...
//   reset
//   start  <workflowIdIgnored> <inputJson>     → { runId, status, ... }
//   resume <runId> <resumeDataJson>            → { status, ... }
//   status <runId>                             → { run, log }
import { openStore } from "./store.mjs";
import { buildWorkflow, stubRunPi } from "./workflow.mjs";
import { run, resume } from "./runner.mjs";

const [,, dbPath, cmd, ...rest] = process.argv;
if (!dbPath || !cmd) {
  console.error("usage: driver.mjs <dbPath> <reset|start|resume|status> ...");
  process.exit(2);
}

const store = openStore(dbPath);
const wf = buildWorkflow();
const ctx = {
  runPi: stubRunPi,
  projectId: "spike-b",
  signal: new AbortController().signal,
  log: () => {},
};
const out = (o) => console.log(JSON.stringify(o));

switch (cmd) {
  case "reset":
    store.reset();
    out({ reset: true });
    break;

  case "start": {
    const input = JSON.parse(rest[1] ?? "{}");
    const runId = "run_" + Math.random().toString(36).slice(2, 10);
    store.createRun({ runId, workflowId: wf.id, projectId: ctx.projectId, input });
    const r = await run(wf, store, runId, ctx);
    out({ runId, ...r });
    break;
  }

  case "resume": {
    const [runId, dataJson] = rest;
    const r = await resume(wf, store, runId, JSON.parse(dataJson ?? "null"), ctx);
    out({ ...r, runId });
    break;
  }

  case "status": {
    const [runId] = rest;
    const row = store.getRun(runId);
    const log = store.getLog(runId);
    out({
      run: row && { status: row.status, workflowId: row.workflowId, input: row.input },
      log: log.map((e) => ({
        seq: e.seq, stepId: e.stepId, status: e.status,
        output: e.output, suspendPayload: e.suspendPayload, resumeData: e.resumeData,
      })),
    });
    break;
  }

  default:
    console.error(`unknown cmd: ${cmd}`);
    process.exit(2);
}

store.close();
