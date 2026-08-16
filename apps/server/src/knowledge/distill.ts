// #36/M5-3 蒸馏链：每周 system 任务把 session 语料 + feedback 蒸馏成三层经验写回 knowledge repo。
// 链路（#33 spec）：语料组装（前缀白名单+水位增量+feedback 重入队）→ headless 蒸馏 pi（纯文本进出，
// zero-extension、无 bridge）产 actions JSON → 服务端白名单校验写回 → git commit（水位同 commit 原子）
// → push best-effort → task_runs note 带 hash。
// 失败语义：pi 错/坏 JSON → 不 commit 不推水位（下轮重读）；拒动作 → 剔除留痕水位照推（防毒丸）。
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { dataDir, generalSessionDir, workspaceSessionDir } from "../config";
import { COMPANY_WORKSPACE_ID } from "../workspaces/store";
import { makeRunPi, type MakeRunPiOpts, type ConfiguredRunPi } from "../pi/runPi-factory";
import { knowledgeRoot, DISTILL_STATE_FILE, ensureKnowledgeRepo } from "./repo";
import type { RunDeps } from "../runs";
import type { WorkflowStore } from "../workflow-engine/store";

/** pi-sessions 根（general + 全部 workspace；水位按文件名集合，跨目录不重名——文件名含时间戳+sessionId）。
 *  路径真相走 config.ts 口径函数（scope.ts 约定）；公司 ws 即 general 目录。 */
function sessionDirs(deps: RunDeps): string[] {
  const dirs = [generalSessionDir()];
  for (const ws of deps.workspaceStore!.listAllWorkspaces()) {
    if (ws.id === COMPANY_WORKSPACE_ID) continue; // 公司 ws 即 general 目录（scope.ts 口径）
    dirs.push(workspaceSessionDir(ws.id));
  }
  return dirs;
}

// ── 语料筛选（纯函数）──
const CORPUS_PREFIXES = ["chat-", "run-"]; // 含用户信号：对话 turn / 工作流 HITL
const EXCLUDED_PREFIXES = ["title-", "task-", "distill-"]; // 命名机械调用 / system headless / 蒸馏自身（防自指）

/** 全部文件名 → 本轮语料（白名单进、排除出、已处理不重进；保持输入顺序）。 */
export function selectCorpusFiles(all: string[], processed: string[]): string[] {
  const done = new Set(processed);
  return all.filter((f) => {
    const stem = f.replace(/^.*Z_/, ""); // 去时间戳前缀（2026-…Z_chat-c1.jsonl → chat-c1.jsonl）
    return CORPUS_PREFIXES.some((p) => stem.startsWith(p))
      && !EXCLUDED_PREFIXES.some((p) => stem.startsWith(p))
      && !done.has(f);
  });
}

/** message 级 feedback 的 targetId（message id）→ conversationId（重入队映射用）——见 WorkflowStore.conversationIdOfMessage。 */

// ── 写回白名单（纯函数）──
export interface DistillAction {
  target: string;
  op: "append" | "revise";
  content: string;
}

const ID_RE = /^[A-Za-z0-9_-]+$/; // userId / skill 名（防路径注入）

/** target → repo 内相对路径；非法（逃逸/未知形态/未知 op）→ undefined。 */
export function validateWriteTarget(a: DistillAction): string | undefined {
  if (a.op !== "append" && a.op !== "revise") return undefined;
  if (typeof a.content !== "string" || !a.content.trim()) return undefined;
  if (a.target === "global") return "experience/global.md";
  if (a.target.startsWith("member:")) {
    const id = a.target.slice("member:".length);
    return ID_RE.test(id) ? join("experience/members", `${id}.md`) : undefined;
  }
  if (a.target.startsWith("learning:")) {
    // learnings/ 审计（spec 写回白名单第四通道）：topic 走 ID_RE，日期服务端产（LLM 不可控时间）
    const topic = a.target.slice("learning:".length);
    return a.op === "append" && ID_RE.test(topic)
      ? join("learnings", `${topic}-${new Date().toISOString().slice(0, 10)}.md`) : undefined;
  }
  if (a.target.startsWith("skill:")) {
    const name = a.target.slice("skill:".length);
    // skill 必须真实存在（repo skills/ 种子目录），防任意目录 append
    const root = knowledgeRoot();
    return ID_RE.test(name) && existsSync(join(root, "skills", name))
      ? join("skills", name, "experience.md") : undefined;
  }
  return undefined;
}

// ── 蒸馏主链 ──
export interface DistillResult {
  ok: boolean;
  note: string; // task_runs note：commit hash + 摘要 / 失败原因 / 拒动作留痕
}

const DISTILL_TIMEOUT_MS = 600_000; // 语料大（放宽到 10 分钟；pi 一次性缓冲调用默认 120s 不够）

const DISTILL_PROMPT_HEAD = `你是 agentany 的经验蒸馏器。以下是本周期新增的对话/工作流执行记录（已过滤噪声），
以及当前知识库中的既有经验。请蒸馏出可复用的经验，输出严格 JSON（不要 markdown 代码块、不要解释）：
{"actions":[{"target":"global|member:<userId>|skill:<skill名>","op":"revise|append","content":"..."}],"commitMessage":"distill: ..."}
规则：
- target=global/member 的 op=revise：给出该文件合并后的完整新内容（合并同类、淘汰过时，优先精简而非新增；禁止包含可识别具体成员/客户/品牌/价格的信息）
- target=skill:* 的 op=append：只给追加条目（append-only，不重写既有内容）\n- target=learning:<topic> 的 op=append：本轮蒸馏的审计结论（本次读了什么、提炼了什么、依据哪些反馈），topic 用短横线英文 slug
- 无人交互的纯机械过程没有经验价值——只从含用户信号（提问方式/纠偏/反馈/选择）的记录中提取\n- 经验文档保持精炼（每个文件 ≤80 行）——合并淘汰优先于新增，宁缺毋滥`;



/** LLM 手写 JSON 容错①：字符串内裸控制字符（\n/\r/\t）转义后重建——状态机感知字符串边界。 */
function escapeRawControls(raw: string): string {
  let out = "", inStr = false, esc = false;
  for (const ch of raw) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { if (inStr) { out += ch; esc = true; } else out += ch; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && (ch === "\n" || ch === "\r" || ch === "\t")) { out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t"; continue; }
    out += ch;
  }
  return out;
}

/** 首个 { 起的括号平衡截断（跳过字符串字面量）——免疫 LLM 尾部多余 } 与围栏/尾注。 */
function balancedJsonPrefix(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function gitOut(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export interface DistillOptions {
  push?: () => void; // 注入 push（默认真推；测试注入失败/跳过）
}

/**
 * 跑一轮蒸馏。deps 需要 store（feedback/message 反查）+ workspaceStore（session 目录枚举）。
 * LLM 经 runPiFactory 注入（默认 makeRunPi）；返回 note 供 executeTask 落 task_runs。
 */
export type DistillPiFactory = (opts: MakeRunPiOpts) => ConfiguredRunPi;

export async function runDistill(
  deps: RunDeps,
  factory?: DistillPiFactory,
  opts: DistillOptions = {},
): Promise<DistillResult> {
  ensureKnowledgeRepo();
  const root = knowledgeRoot();
  const statePath = join(root, DISTILL_STATE_FILE);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { processedFiles: string[]; lastFeedbackId: number };

  // 1) 语料组装：全部 session 文件名 → 水位筛选
  const allNames: string[] = [];
  for (const dir of sessionDirs(deps)) {
    if (!existsSync(dir)) continue;
    allNames.push(...readdirSync(dir).filter((f) => f.endsWith(".jsonl")));
  }
  let corpus = selectCorpusFiles(allNames, state.processedFiles);

  // 2) feedback 增量：id > lastFeedbackId 的行 → 关联文件重入队 + feedback 内容进语料
  const feedbacks = deps.store.listFeedbackSince(state.lastFeedbackId);
  const reQueued: string[] = [];
  for (const fb of feedbacks) {
    const convId = deps.store.conversationOfFeedbackTarget(fb.targetKind, fb.targetId)?.id;
    if (!convId) continue;
    for (const name of allNames.filter((n) => n.endsWith(`chat-${convId}.jsonl`))) {
      if (!corpus.includes(name)) { corpus.push(name); reQueued.push(name); }
    }
  }

  // 无新语料：直接 ok（不空跑 LLM）
  if (corpus.length === 0 && feedbacks.length === 0) {
    return { ok: true, note: "no new corpus" };
  }

  // 3) 组 prompt：语料（截断）+ feedback（全量）+ 既有经验现状
  const parts: string[] = [DISTILL_PROMPT_HEAD];
  for (const name of corpus) {
    parts.push(`\n===== 记录 ${name} =====\n${readCorpusFile(name, deps)}`);
  }
  for (const fb of feedbacks) {
    parts.push(`\n===== 反馈 ${fb.targetKind}/${fb.targetId} rating=${fb.rating ?? "-"} =====\n${fb.text}`);
  }
  parts.push(`\n===== 既有经验现状 =====\n${readIfExists(join(root, "experience/global.md"))}`);
  parts.push(readIfExists(join(root, "experience/members/_.md"))); // 占位：现状按需扩展（member 文件逐个列）
  const existingMembers = existsSync(join(root, "experience/members"))
    ? readdirSync(join(root, "experience/members")).filter((f) => f.endsWith(".md")) : [];
  for (const m of existingMembers) {
    parts.push(`\n----- experience/members/${m} -----\n${readFileSync(join(root, "experience/members", m), "utf8")}`);
  }

  // 4) 蒸馏 pi：headless 纯文本（zero-extension、无 bridge、timeout 放宽）
  const runPi = (factory ?? makeRunPi)({ extensions: [], scope: "general", workspaceId: null, sessionId: "distill-weekly" });
  let raw: string;
  try {
    const r = await runPi({ prompt: parts.join("\n"), timeoutMs: DISTILL_TIMEOUT_MS });
    raw = r.text;
  } catch (e) {
    return { ok: false, note: `distill pi failed: ${(e as Error)?.message ?? String(e)}` };
  }

  // 5) 解析 JSON（容 markdown 围栏）
  let parsed: { actions?: DistillAction[]; commitMessage?: string };
  try {
    // LLM 手写长 JSON 容错：裸控制字符转义（实测高频）→ 平衡截断（免疫尾注/多余括号）→ parse
    const fixed = escapeRawControls(raw);
    const m = balancedJsonPrefix(fixed);
    parsed = JSON.parse(m ?? fixed);
  } catch (e) {
    // 事后检查素材：LLM 原文落 knowledge repo 外层（不进 git——诊断用）；note 尾部+头部可诊断
    try {
      writeFileSync(join(dataDir(), "distill-last-raw.txt"), raw, "utf8");
    } catch { /* 诊断落盘失败不掩盖原错误 */ }
    return { ok: false, note: `distill bad JSON (len=${raw.length}): ${(e as Error).message} | head=${raw.slice(0, 150)} | tail=${raw.slice(-150)}` };
  }

  // 6) 白名单校验 + 写回（拒动作剔除留痕）。写前快照原内容——commit 失败时文件级恢复
  // （git checkout 在 index.lock 等场景自身不可用且不清未跟踪文件，回滚不依赖 git）。
  const rejected: string[] = [];
  const applied: string[] = [];
  const snapshot: Array<{ abs: string; prev: Buffer | null }> = [];
  const snap = (abs: string) => snapshot.push({ abs, prev: existsSync(abs) ? readFileSync(abs) : null });
  for (const a of parsed.actions ?? []) {
    const rel = validateWriteTarget(a);
    if (!rel) { rejected.push(a?.target ?? String(a)); continue; }
    const abs = join(root, rel);
    snap(abs);
    mkdirSync(join(abs, ".."), { recursive: true });
    if (a.op === "append") appendFileSync(abs, `${a.content.endsWith("\n") ? "" : "\n"}${a.content}\n`, "utf8");
    else writeFileSync(abs, a.content, "utf8");
    applied.push(rel);
  }

  // 7) 水位推进（同 commit 原子）：本轮语料全标已处理（含重入队——其 feedback 已消费）
  const newState = {
    processedFiles: [...state.processedFiles, ...corpus],
    lastFeedbackId: maxFeedbackId(deps, state.lastFeedbackId, feedbacks),
  };
  writeFileSync(statePath, JSON.stringify(newState, null, 2), "utf8");

  // 8) commit（含写回 + 水位）+ push best-effort。commit 抛错 → restore 全部未提交变更
  // （水位+经验写回一起丢弃，回到本轮起点——原子性；下轮重读同批素材）。
  const msg = parsed.commitMessage?.trim() || "distill: weekly batch";
  try {
    gitOut(["add", "-A"], root);
    gitOut(["commit", "-q", "-m", msg, "--allow-empty"], root);
  } catch (e) {
    // 文件级回滚：快照逆序恢复（append 场景同文件多动作要逆序）+ 水位恢复原文；恢复失败仅记 warn
    try {
      for (const { abs, prev } of snapshot.reverse()) {
        if (prev === null) rmSync(abs, { force: true });
        else writeFileSync(abs, prev);
      }
      writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    } catch (e2) { console.warn("[distill] rollback failed:", e2); }
    return { ok: false, note: `distill commit failed: ${(e as Error)?.message ?? String(e)}（写回已回滚，下轮重读）` };
  }
  const hash = gitOut(["rev-parse", "--short", "HEAD"], root);
  const pushNote = doPush(opts, root);

  const bits = [`commit ${hash} ${msg.slice(0, 40)}`, applied.length ? `applied: ${applied.join(", ")}` : "no actions",
    reQueued.length ? `requeued: ${reQueued.length}` : "", rejected.length ? `拒绝 ${rejected.length} 个非法动作(${rejected.join(";")})` : "",
    pushNote].filter(Boolean);
  return { ok: true, note: bits.join(" | ") };
}

function readCorpusFile(name: string, deps: RunDeps): string {
  for (const dir of sessionDirs(deps)) {
    const p = join(dir, name);
    if (existsSync(p)) {
      const t = readFileSync(p, "utf8");
      return t.length > 8_000 ? `${t.slice(0, 8_000)}\n…(截断)` : t; // 单文件 8k 截断防爆 prompt
    }
  }
  return "(file missing)";
}

function readIfExists(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf8") : "(空)";
}

// ── feedback 增量/反查：直调 WorkflowStore（listFeedbackSince / conversationOfFeedbackTarget）──

function maxFeedbackId(deps: RunDeps, prev: number, rows: ReturnType<WorkflowStore["listFeedbackSince"]>): number {
  const m = rows.reduce((acc, r) => Math.max(acc, r.id), prev);
  return Math.max(m, deps.store.maxFeedbackId());
}

function doPush(opts: DistillOptions, root: string): string {
  try {
    (opts.push ?? (() => {
      try { execFileSync("git", ["push"], { cwd: root, stdio: "ignore" }); } catch { /* 无远端=正常 */ }
    }))();
    return "";
  } catch (e) {
    return `push failed: ${(e as Error).message}（本地 commit 为真相源）`;
  }
}
