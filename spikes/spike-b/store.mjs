// spikes/spike-b/store.mjs — append-only 执行日志（bun:sqlite）。
// spike 直用 sqlite；prod 这层换 Drizzle 包同一份 schema（见 ADR-0004/0006）。
import { Database } from "bun:sqlite";

export function openStore(dbPath) {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      runId        TEXT PRIMARY KEY,
      workflowId   TEXT NOT NULL,
      projectId    TEXT NOT NULL,
      status       TEXT NOT NULL,   -- running|suspended|completed|failed
      input        TEXT NOT NULL,   -- JSON
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_run_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      runId          TEXT NOT NULL,
      seq            INTEGER NOT NULL,          -- 单调（per-run）
      stepId         TEXT NOT NULL,
      status         TEXT NOT NULL,             -- running|completed|suspended|failed
      input          TEXT,                      -- JSON：该步被调用时的输入（suspend 续跑重执行要用）
      output         TEXT,                      -- JSON：该步产出（completed）
      suspendPayload TEXT,                      -- JSON
      resumeSchema   TEXT,                      -- JSON：续跑数据契约
      resumeData     TEXT,                      -- JSON：实际续跑数据（resume 产生的条目记，便于追溯/幂等）
      ts             TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_log_run ON workflow_run_log(runId, seq);
  `);

  const qCreateRun = db.prepare(
    `INSERT INTO workflow_runs (runId,workflowId,projectId,status,input,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)`
  );
  const qNextSeq = db.prepare(
    `SELECT COALESCE(MAX(seq),0)+1 AS s FROM workflow_run_log WHERE runId=?`
  );
  const qAppend = db.prepare(
    `INSERT INTO workflow_run_log (runId,seq,stepId,status,input,output,suspendPayload,resumeSchema,resumeData,ts) VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const qGetRun = db.prepare(`SELECT * FROM workflow_runs WHERE runId=?`);
  const qGetLog = db.prepare(`SELECT * FROM workflow_run_log WHERE runId=? ORDER BY seq ASC`);
  const qUpdStatus = db.prepare(`UPDATE workflow_runs SET status=?, updatedAt=? WHERE runId=?`);

  const J = (v) => (v === undefined ? null : JSON.stringify(v));
  const P = (row, k) => (row && row[k] != null ? JSON.parse(row[k]) : null);

  return {
    createRun({ runId, workflowId, projectId, input }) {
      const now = new Date().toISOString();
      qCreateRun.run(runId, workflowId, projectId, "running", J(input), now, now);
    },
    appendLog(runId, e) {
      const seq = qNextSeq.get(runId).s;
      qAppend.run(
        runId, seq, e.stepId, e.status,
        J(e.input), J(e.output), J(e.suspendPayload), J(e.resumeSchema), J(e.resumeData),
        new Date().toISOString()
      );
      return seq;
    },
    getRun(runId) {
      const r = qGetRun.get(runId);
      return r ? { ...r, input: P(r, "input") } : null;
    },
    getLog(runId) {
      return qGetLog.all(runId).map((r) => ({
        ...r,
        input: P(r, "input"),
        output: P(r, "output"),
        suspendPayload: P(r, "suspendPayload"),
        resumeSchema: P(r, "resumeSchema"),
        resumeData: P(r, "resumeData"),
      }));
    },
    updateRunStatus(runId, status) {
      qUpdStatus.run(status, new Date().toISOString(), runId);
    },
    reset() {
      db.exec(`DELETE FROM workflow_run_log; DELETE FROM workflow_runs;`);
    },
    close() {
      db.close();
    },
  };
}
