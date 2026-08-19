// #36/M5-3 蒸馏链测试。
// seam ①纯函数：语料筛选（前缀白名单/排除）、写回路径白名单、水位运算；
// seam ②直构+stub：runDistill 全链（语料组装→LLM JSON→白名单写回→git commit→水位→note）；
// 真 git 临时目录验证 commit；失败语义（pi 错/坏 JSON 不推水位；拒动作剔除照推）。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { ensureKnowledgeRepo, knowledgeRoot, DISTILL_STATE_FILE } from "../src/knowledge/repo";
import {
  selectCorpusFiles, validateWriteTarget, type DistillAction,
} from "../src/knowledge/distill";
import { runDistill } from "../src/knowledge/distill";
import type { RunDeps } from "../src/runs";

const TEST_DATA = resolve("tmp-distill-test-data");

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setup() {
  const db = openDbMigrated(":memory:");
  const store = new WorkflowStore(db);
  const deps: RunDeps = {
    store,
    userStore: new UserStore(db),
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store),
    eventBus: new EventBus(),
  };
  return { deps, store };
}

beforeEach(() => {
  rmSync(TEST_DATA, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA;
});
afterEach(() => {
  delete process.env.DATA_DIR;
  rmSync(TEST_DATA, { recursive: true, force: true });
});

/** 在 general sessionDir 造 session 文件（pi 每 turn 一文件的仿真）。 */
function seedSession(name: string, lines = 2) {
  const dir = join(TEST_DATA, "general", "pi-sessions");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${name}.jsonl`);
  writeFileSync(f, Array.from({ length: lines }, (_, i) =>
    JSON.stringify({ type: "message", message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `msg${i}` }] } }),
  ).join("\n"), "utf8");
  return `${name}.jsonl`;
}

/** stub LLM factory：runPi 一次性调用返回 JSON 文本。 */
function stubLlm(out: { json?: unknown; error?: Error; raw?: string }) {
  const calls: any[] = [];
  const factory = (opts: any) => async (call: any) => {
    calls.push({ prompt: call.prompt, timeoutMs: call.timeoutMs, extensions: opts.extensions, appendSystemPrompt: call.appendSystemPrompt });
    if (out.error) throw out.error;
    if (out.raw !== undefined) return { text: out.raw, messages: [], toolResults: [] };
    return { text: JSON.stringify(out.json), messages: [], toolResults: [] };
  };
  return { factory, calls };
}

// ═══ ① 语料筛选（纯函数）═══
describe("selectCorpusFiles（前缀白名单 + 水位增量）", () => {
  test("chat-/run- 进；title-/task-/distill- 出；已处理不重进", () => {
    const all = [
      "2026-08-10T00-00-00-000Z_chat-c1.jsonl",
      "2026-08-10T00-00-00-001Z_run-r1.jsonl",
      "2026-08-10T00-00-00-002Z_title-c1.jsonl",
      "2026-08-10T00-00-00-003Z_task-t1.jsonl",
      "2026-08-10T00-00-00-004Z_distill-x.jsonl",
      "2026-08-10T00-00-00-005Z_chat-c2.jsonl",
    ];
    const picked = selectCorpusFiles(all, ["2026-08-10T00-00-00-000Z_chat-c1.jsonl"]);
    expect(picked).toEqual(["2026-08-10T00-00-00-001Z_run-r1.jsonl", "2026-08-10T00-00-00-005Z_chat-c2.jsonl"]);
  });
});

// ═══ ② 写回路径白名单（纯函数）═══
describe("validateWriteTarget（路径白名单）", () => {
  test("合法 target → repo 内相对路径", () => {
    ensureKnowledgeRepo(); // skill 存在性校验依赖 repo skills/ 种子
    expect(validateWriteTarget({ target: "global", op: "revise", content: "x" })).toBe("experience/global.md");
    expect(validateWriteTarget({ target: "member:u1", op: "revise", content: "x" })).toBe("experience/members/u1.md");
    expect(validateWriteTarget({ target: "skill:brand-research", op: "append", content: "x" })).toBe("skills/brand-research/experience.md");
  });
  test("非法 target → undefined（路径逃逸/未知 skill/坏前缀）", () => {
    expect(validateWriteTarget({ target: "../../etc/passwd", op: "append", content: "x" })).toBeUndefined();
    expect(validateWriteTarget({ target: "member:../escape", op: "revise", content: "x" })).toBeUndefined();
    expect(validateWriteTarget({ target: "skill:../../evil", op: "append", content: "x" })).toBeUndefined();
    expect(validateWriteTarget({ target: "unknown:x", op: "append", content: "x" })).toBeUndefined();
    expect(validateWriteTarget({ target: "global", op: "delete", content: "x" } as unknown as DistillAction)).toBeUndefined(); // 未知 op
  });
});

// ═══ ③ runDistill 全链（直构 + stub LLM + 真 git）═══
describe("runDistill（#36 蒸馏全链）", () => {
  function readState(): any {
    return JSON.parse(readFileSync(join(knowledgeRoot(), DISTILL_STATE_FILE), "utf8"));
  }

  test("合法 actions → 按 target 写回 + git commit（LLM commitMessage）+ 水位推进 + note 带 hash", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    seedSession("2026-08-10T00-00-00-001Z_title-c1"); // 噪声：不该进语料
    const llm = stubLlm({ json: {
      actions: [
        { target: "global", op: "revise", content: "通用：汇报先给结论" },
        { target: "member:u1", op: "revise", content: "u1 偏好简短" },
        { target: "skill:brand-research", op: "append", content: "- 新经验：来源要标日期" },
      ],
      commitMessage: "distill: 2026-W33 反馈批次",
    } });
    const res = await runDistill(deps, llm.factory as any);
    // 写回
    const root = knowledgeRoot();
    expect(readFileSync(join(root, "experience/global.md"), "utf8")).toContain("先给结论");
    expect(readFileSync(join(root, "experience/members/u1.md"), "utf8")).toContain("u1 偏好简短");
    expect(readFileSync(join(root, "skills/brand-research/experience.md"), "utf8")).toContain("标日期");
    // commit：message=LLM 产；水位同 commit（工作区干净）
    const log = git(["log", "--oneline"], root);
    expect(log).toContain("distill: 2026-W33 反馈批次");
    expect(git(["status", "--porcelain"], root)).toBe("");
    // 水位推进：chat-c1 进、title-c1 不进
    expect(readState().processedFiles).toEqual(["2026-08-10T00-00-00-000Z_chat-c1.jsonl"]);
    // note 带 hash + 摘要
    expect(res.ok).toBe(true);
    expect(res.note).toContain("distill: 2026-W33 反馈批次".slice(0, 10));
    expect(res.note).toMatch(/[0-9a-f]{7,40}/); // commit hash
    // 语料：LLM prompt 含 chat 段内容、不含 title 段
    expect(llm.calls[0].prompt).toContain("chat-c1");
    expect(llm.calls[0].prompt).not.toContain("title-c1");
  });

  test("skill append 保留原内容（append-only 不覆盖）", async () => {
    ensureKnowledgeRepo();
    const root = knowledgeRoot();
    writeFileSync(join(root, "skills/brand-research/experience.md"), "# 既有经验\n- 旧条目", "utf8");
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const llm = stubLlm({ json: { actions: [{ target: "skill:brand-research", op: "append", content: "- 新条目" }], commitMessage: "m" } });
    await runDistill(deps, llm.factory as any);
    const t = readFileSync(join(root, "skills/brand-research/experience.md"), "utf8");
    expect(t).toContain("旧条目");
    expect(t).toContain("新条目");
  });

  test("非法 target 动作被剔除：合法动作照常落、note 留痕、水位照推", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const llm = stubLlm({ json: {
      actions: [
        { target: "global", op: "revise", content: "合法" },
        { target: "member:../evil", op: "revise", content: "非法" },
      ],
      commitMessage: "mixed",
    } });
    const res = await runDistill(deps, llm.factory as any);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(knowledgeRoot(), "experience/global.md"), "utf8")).toContain("合法");
    expect(existsSync(join(knowledgeRoot(), "experience/members/../evil.md"))).toBe(false); // 等价：无逃逸文件
    expect(res.note).toContain("拒绝"); // 留痕
    expect(readState().processedFiles).toEqual(["2026-08-10T00-00-00-000Z_chat-c1.jsonl"]); // 照推
  });

  test("LLM 报错 → 无新 commit、水位不动", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const before = git(["log", "--oneline"], knowledgeRoot());
    const llm = stubLlm({ error: new Error("pi down") });
    const res = await runDistill(deps, llm.factory as any);
    expect(res.ok).toBe(false);
    expect(git(["log", "--oneline"], knowledgeRoot())).toBe(before); // 无新 commit
    expect(readState().processedFiles).toEqual([]);
  });

  test("字符串内裸换行（实测高频）→ 转义容错可解析", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    // content 里是真实裸换行（LLM 不转义的高频错法）
    const raw = '{"actions":[{"target":"global","op":"revise","content":"# 经验\n（此处为裸换行）\n## 第一条\n- 内容"}],"commitMessage":"m"}'.replace(/\\n/g, "\n");
    const llm = stubLlm({ raw });
    const res = await runDistill(deps, llm.factory as any);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(knowledgeRoot(), "experience/global.md"), "utf8")).toContain("第一条");
  });

  test("learning target → learnings/<topic>-<date>.md 落盘（审计通道）", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const llm = stubLlm({ json: { actions: [
      { target: "learning:weekly-audit", op: "append", content: "# 本轮蒸馏审计\n读了 1 个会话文件" },
    ], commitMessage: "m" } });
    const res = await runDistill(deps, llm.factory as any);
    expect(res.ok).toBe(true);
    const files = readdirSync(join(knowledgeRoot(), "learnings")).filter((f) => f.startsWith("weekly-audit-"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/weekly-audit-\d{4}-\d{2}-\d{2}\.md$/);
    expect(readFileSync(join(knowledgeRoot(), "learnings", files[0]), "utf8")).toContain("蒸馏审计");
  });

  test("commit 失败 → 工作区回滚（水位/经验写回丢弃）、run failed", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const global = join(knowledgeRoot(), "experience/global.md");
    mkdirSync(join(global, ".."), { recursive: true });
    writeFileSync(global, "旧经验", "utf8"); // 预置既有内容（回滚应恢复到它）
    const llm = stubLlm({ json: { actions: [{ target: "global", op: "revise", content: "新经验" }], commitMessage: "m" } });
    // C1/#66：commit seam 注入必败——直测快照回滚路径（不再 hack .git/index.lock）
    const res = await runDistill(deps, llm.factory as any, {
      commit: () => { throw new Error("模拟 commit 失败"); },
    });
    expect(res.ok).toBe(false);
    expect(res.note).toContain("commit failed");
    expect(readFileSync(global, "utf8")).toBe("旧经验"); // 文件级快照回滚（writeBack 恢复，非 git checkout）
    expect(readState().processedFiles).toEqual([]); // 水位未推进
  });

  test("LLM 尾部多余 }（实测冒烟样本）→ 平衡截断可解析", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const llm = stubLlm({ raw: '{"actions":[{"target":"global","op":"revise","content":"x"}],"commitMessage":"m"}}\n（以上为蒸馏结果）' });
    const res = await runDistill(deps, llm.factory as any);
    expect(res.ok).toBe(true); // 尾部 }+尾注被平衡截断剥掉
    expect(readFileSync(join(knowledgeRoot(), "experience/global.md"), "utf8")).toContain("x");
  });

  test("坏 JSON → 无 commit、水位不动", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const before = git(["log", "--oneline"], knowledgeRoot());
    const llm = stubLlm({ raw: "这不是 JSON" });
    const res = await runDistill(deps, llm.factory as any);
    expect(res.ok).toBe(false);
    expect(git(["log", "--oneline"], knowledgeRoot())).toBe(before);
    expect(readState().processedFiles).toEqual([]);
  });

  test("二次蒸馏：已处理文件不重读（水位幂等）、新文件进", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const llm1 = stubLlm({ json: { actions: [], commitMessage: "first" } });
    await runDistill(deps, llm1.factory as any);
    seedSession("2026-08-11T00-00-00-000Z_chat-c2");
    const llm2 = stubLlm({ json: { actions: [], commitMessage: "second" } });
    await runDistill(deps, llm2.factory as any);
    expect(llm2.calls[0].prompt).not.toContain("chat-c1"); // 不重读
    expect(llm2.calls[0].prompt).toContain("chat-c2");
    expect(readState().processedFiles).toHaveLength(2);
  });

  test("新 feedback → 已处理关联文件重新入队", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    const conv = deps.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u1" });
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const llm1 = stubLlm({ json: { actions: [], commitMessage: "first" } });
    await runDistill(deps, llm1.factory as any); // c1 已处理
    // 落一条 message 级 feedback（targetId=message id → conversation c1）
    const msgId = deps.store.appendMessage({ conversationId: "c1", role: "assistant", content: "答" });
    deps.store.addFeedback({ targetKind: "message", targetId: String(msgId), text: "很好用", rating: 5 });
    const llm2 = stubLlm({ json: { actions: [], commitMessage: "second" } });
    await runDistill(deps, llm2.factory as any);
    expect(llm2.calls[0].prompt).toContain("chat-c1"); // 重新入队
    expect(llm2.calls[0].prompt).toContain("很好用"); // feedback 内容进语料
    expect(readState().lastFeedbackId).toBeGreaterThan(0);
  });

  test("push 失败 → run 仍 ok、note 记 push 失败", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const llm = stubLlm({ json: { actions: [], commitMessage: "m" } });
    const res = await runDistill(deps, llm.factory as any, { push: () => { throw new Error("no remote"); } });
    expect(res.ok).toBe(true);
    expect(res.note).toContain("push");
  });

  test("蒸馏 pi 无 extensions、timeout 放宽（stub 断言）", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const llm = stubLlm({ json: { actions: [], commitMessage: "m" } });
    await runDistill(deps, llm.factory as any);
    expect(llm.calls[0].extensions ?? []).toEqual([]); // zero-extension
    expect(llm.calls[0].timeoutMs).toBeGreaterThan(120_000); // 放宽（默认 120s 以上）
  });
});

// ═══ ④ executeTask 蒸馏特判 → task_runs note 带 hash（admin 任务页数据源）═══
describe("executeTask 蒸馏 seed（#36 集成）", () => {
  test("t_seed_distill 到点执行 → runDistill 全链 → task_runs ok + note 含 commit hash", async () => {
    ensureKnowledgeRepo();
    const { deps } = setup();
    seedSession("2026-08-10T00-00-00-000Z_chat-c1");
    const llm = stubLlm({ json: { actions: [{ target: "global", op: "revise", content: "x" }], commitMessage: "集成批" } });
    deps.runPiFactory = llm.factory as any;
    // seed 任务行：迁移 0013 已 INSERT OR IGNORE 同 id 行（in-memory DB 亦有）——直接取用
    const task = deps.taskStore!.getTask("t_seed_distill")!;
    expect(task).toBeDefined();
    const { makeExecuteTask } = await import("../src/scheduled-tasks/execute");
    await makeExecuteTask({ deps, queues: new (await import("../src/chat/queue")).ConversationQueues(), eventBus: deps.eventBus! })(task, "cron");
    const runs = deps.taskStore!.listRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].note).toMatch(/commit [0-9a-f]{7,40}/); // admin 任务页可读的 hash
  });
});
