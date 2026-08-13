// spikes/spike-b/test.mjs — 5 判据编排器。所有断言经 driver 子进程验证（spawnSync）。
// 「杀进程续跑」= 两次独立子进程调用（start 挂起退出 → 全新进程 resume），诚实验证盘上持久化。
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const DB = "/tmp/spike-b-test.sqlite";
const DRIVER = new URL("./driver.mjs", import.meta.url).pathname;

let pass = 0, fail = 0;
function drive(cmd, ...args) {
  const r = spawnSync("bun", ["run", DRIVER, DB, cmd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`driver ${cmd} rc=${r.status}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}  ${detail ?? ""}`); }
}
const fresh = () => { rmSync(DB, { force: true }); };

// ───────── 1. 接受路径：s1 → review → s2 ─────────
fresh();
let r = drive("start", "wf", JSON.stringify({ offset: 0 }));
check("1 start → suspended at review", r.status === "suspended" && r.stepId === "review", JSON.stringify(r));
const rid1 = r.runId;
r = drive("resume", rid1, JSON.stringify({ decision: "accept" }));
check("1 accept → completed", r.status === "completed", JSON.stringify(r));
const st1 = drive("status", rid1);
// append-only + replay-free 两相：HITL 步留 2 条（suspended + completed）。逻辑路径按 completed 取。
const completed1 = st1.log.filter((e) => e.status === "completed").map((e) => e.stepId);
check("1 完成路径 = s1,review,s2", completed1.join(",") === "s1,review,s2", completed1.join(","));
const review1 = st1.log.filter((e) => e.stepId === "review").map((e) => e.status);
check("1 review = suspended→completed 两相（2 条）", review1.join(",") === "suspended,completed", review1.join(","));

// ───────── 2. 循环路径：redirect 回 s1（带新 offset） ─────────
fresh();
r = drive("start", "wf", JSON.stringify({ offset: 0 }));
const rid2 = r.runId;
r = drive("resume", rid2, JSON.stringify({ decision: "redirect", focus: "brand" }));
check("2 redirect → 再挂起在 review（循环回 s1 后）", r.status === "suspended" && r.stepId === "review", JSON.stringify(r));
r = drive("resume", rid2, JSON.stringify({ decision: "accept" }));
check("2 随后 accept → completed", r.status === "completed", JSON.stringify(r));
const st2 = drive("status", rid2);
const s1s = st2.log.filter((e) => e.stepId === "s1");
check("2 日志含 2 条 s1（循环）", s1s.length === 2, `got ${s1s.length}`);
const offs = s1s.map((e) => e.output?.offset);
check("2 s1 offset 0→1 递增（循环携带新数据）", offs[0] === 0 && offs[1] === 1, JSON.stringify(offs));

// ───────── 3. 杀进程续跑：两次独立子进程 ─────────
fresh();
const r3a = drive("start", "wf", JSON.stringify({ offset: 5 })); // 进程 A：挂起后退出
check("3a 进程A start → suspended", r3a.status === "suspended", JSON.stringify(r3a));
const r3b = drive("resume", r3a.runId, JSON.stringify({ decision: "accept" })); // 进程 B（全新）
check("3b 全新进程 resume → completed（盘上日志生效）", r3b.status === "completed", JSON.stringify(r3b));

// ───────── 4. resumeData 校验：坏数据被拒、不改状态 ─────────
fresh();
r = drive("start", "wf", JSON.stringify({ offset: 0 }));
const rid4 = r.runId;
r = drive("resume", rid4, JSON.stringify({ decision: "bogus" })); // 非法 enum
check("4 非法 resumeData 被拒", r.rejected === true, JSON.stringify(r));
const st4 = drive("status", rid4);
check("4 状态仍 suspended（未改动）", st4.run.status === "suspended", st4.run.status);
const len4 = st4.log.length;
r = drive("resume", rid4, JSON.stringify({ decision: "accept" })); // 随后合法 resume
check("4 被拒后合法 resume 仍能推进到 completed", r.status === "completed", JSON.stringify(r));
const st4b = drive("status", rid4);
check("4 被拒那次没留垃圾条目（合法续跑后日志 = 拒绝前 + 正常推进）", st4b.log.length > len4, `${len4} → ${st4b.log.length}`);

// ───────── 5. 幂等 resume：重复提交不产生重复推进 ─────────
fresh();
r = drive("start", "wf", JSON.stringify({ offset: 0 }));
const rid5 = r.runId;
r = drive("resume", rid5, JSON.stringify({ decision: "accept" }));
check("5 首次 resume → completed", r.status === "completed", JSON.stringify(r));
const len5 = drive("status", rid5).log.length;
r = drive("resume", rid5, JSON.stringify({ decision: "accept" })); // 重复同一份数据
check("5 重复 resume = 幂等 no-op", r.idempotent === true, JSON.stringify(r));
const len5b = drive("status", rid5).log.length;
check("5 日志条目数未增长", len5b === len5, `${len5} → ${len5b}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
