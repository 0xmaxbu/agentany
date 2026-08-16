// #35/M5-2 knowledge repo + 注入通道。
// seam ①纯函数/真 git 临时目录：ensureKnowledgeRepo（init+布局+首 commit+skills 种子）；
// seam ②注入组装：collectExperience（global/member 分层、缺文件跳过）；
// seam ③直构+stub：executeTask 任务 turn 吃 global 不吃 member；chat turn（turn-trigger 已覆盖路由层，
//   这里以 runTurn 直调断言 appendSystemPrompt 分层）。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { makeExecuteTask } from "../src/scheduled-tasks/execute";
import { ConversationQueues } from "../src/chat/queue";
import type { RunDeps } from "../src/runs";
import {
  ensureKnowledgeRepo, knowledgeRoot, collectExperience, DISTILL_STATE_FILE,
} from "../src/knowledge/repo";
import type { StreamBlock } from "../src/blocks";

// 测试用独立 DATA_DIR 根（不污染 data/）——子进程 git 也在此仓库内操作
const TEST_DATA = resolve("tmp-knowledge-test-data");

// ── stub runPiStream：记录 appendSystemPrompt / prompt ──
function stubStreamFactory(results: Array<{ text?: string; blocks?: StreamBlock[] }>) {
  const calls: any[] = [];
  const factory = (opts: { extensions?: string[] }) => {
    return async (call: any) => {
      calls.push({ prompt: call.prompt, appendSystemPrompt: call.appendSystemPrompt, extensions: opts.extensions });
      const r = results[Math.min(calls.length - 1, results.length - 1)];
      for (const b of r?.blocks ?? []) call.onBlock?.(b);
      return { text: r?.text ?? "ok", messages: [], toolResults: [] };
    };
  };
  return { factory, calls };
}

function mkDeps(factory: any, db = openDbMigratedMem()): { deps: RunDeps; db: any } {
  const store = new WorkflowStore(db);
  const deps: RunDeps = {
    store,
    userStore: new UserStore(db),
    streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store),
    eventBus: new EventBus(),
    runPiStreamFactory: factory,
  };
  return { deps, db };
}
import { openDbMigrated } from "../src/db/client";
function openDbMigratedMem() { return openDbMigrated(":memory:"); }

beforeEach(() => {
  rmSync(TEST_DATA, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA;
});
afterEach(() => {
  delete process.env.DATA_DIR;
  rmSync(TEST_DATA, { recursive: true, force: true });
});

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// ═══ ① ensureKnowledgeRepo：init + 布局 + 首 commit + skills 种子 ═══
describe("ensureKnowledgeRepo（仓库初始化）", () => {
  test("空目录 → git init + 布局齐全 + 首 commit + skills 种子复制", () => {
    ensureKnowledgeRepo();
    const root = knowledgeRoot();
    // 布局
    for (const p of ["experience", "experience/members", "learnings", "skills"]) {
      expect(existsSync(join(root, p))).toBe(true);
    }
    expect(existsSync(join(root, DISTILL_STATE_FILE))).toBe(true);
    // git：init 过 + 有首 commit + 工作区干净
    expect(git(["rev-parse", "--is-inside-work-tree"], root)).toBe("true");
    expect(git(["log", "--oneline"], root)).toContain("init");
    expect(git(["status", "--porcelain"], root)).toBe("");
    // skills 种子：repo skills/<name>/SKILL.md 复制进来（brand-research 等）
    expect(existsSync(join(root, "skills/brand-research/SKILL.md"))).toBe(true);
  });

  test("二次调用幂等：不重复 init、不覆盖已写内容", () => {
    ensureKnowledgeRepo();
    const root = knowledgeRoot();
    writeFileSync(join(root, "experience/global.md"), "# 手写经验\n- 用户喜欢简短", "utf8");
    ensureKnowledgeRepo(); // 再跑不报错、不覆盖
    expect(readFileSync(join(root, "experience/global.md"), "utf8")).toContain("手写经验");
    // 也不产生第二个 init commit（log 仍 1 行或手写未提交，总之无重复 init）
    expect(git(["log", "--oneline"], root).split("\n").filter((l) => l.includes("init"))).toHaveLength(1);
  });
});

// ═══ ② collectExperience：分层读取（纯读，不写）═══
describe("collectExperience（注入组装）", () => {
  test("global + 指定 member → 两段；其他 member 文件不进来", () => {
    ensureKnowledgeRepo();
    const root = knowledgeRoot();
    writeFileSync(join(root, "experience/global.md"), "通用：汇报先给结论", "utf8");
    mkdirSync(join(root, "experience/members"), { recursive: true });
    writeFileSync(join(root, "experience/members/u1.md"), "u1 偏好中文简体", "utf8");
    writeFileSync(join(root, "experience/members/u2.md"), "u2 偏好英文", "utf8");
    const parts = collectExperience("u1");
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain("汇报先给结论");
    expect(parts.some((p) => p.includes("u1 偏好中文简体"))).toBe(true);
    expect(parts.some((p) => p.includes("u2 偏好英文"))).toBe(false); // 他人隔离
  });

  test("缺文件 → 跳过该层不报错（空数组/仅存在的层）", () => {
    ensureKnowledgeRepo(); // 未手写任何经验
    expect(collectExperience("u9")).toEqual([]); // global 缺 + member 缺 → 无段
    const root = knowledgeRoot();
    writeFileSync(join(root, "experience/global.md"), "只有 global", "utf8");
    const parts = collectExperience("u9");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("只有 global");
  });
});

// ═══ ③ 任务 turn 注入：global 进、member 不进（D1）═══
describe("executeTask 任务 turn 经验注入（#35）", () => {
  test("任务 pi appendSystemPrompt 含 global 经验、不含任何 member 经验", async () => {
    ensureKnowledgeRepo();
    const root = knowledgeRoot();
    writeFileSync(join(root, "experience/global.md"), "通用：产出末尾附来源链接", "utf8");
    mkdirSync(join(root, "experience/members"), { recursive: true });
    writeFileSync(join(root, "experience/members/u_test.md"), "u_test 私有偏好", "utf8");

    const stub = stubStreamFactory([{ text: "产出" }]);
    const { deps } = mkDeps(stub.factory);
    const task = deps.taskStore!.createWorkspaceTask({
      displayName: "T", cron: "0 */4 * * *", prompt: "做点事",
      workspaceId: "ws_company", creatorId: "u_test", firstFireAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! })(task, "cron");
    await new Promise((r) => setTimeout(r, 30));

    expect(stub.calls.length).toBeGreaterThan(0);
    const asp = stub.calls[0].appendSystemPrompt ?? [];
    const joined = asp.join("\n");
    expect(joined).toContain("产出末尾附来源链接"); // global 注入
    expect(joined).toContain("定时任务执行器"); // 原任务语境保留
    expect(joined).not.toContain("u_test 私有偏好"); // member 不进任务 turn
  });
});

// ═══ ④ chat turn 注入：global 全员 + member 按 userId（runTurn 直调 seam）═══
describe("runTurn chat turn 经验注入（#35）", () => {
  async function runChatTurn(deps: RunDeps, conversationId: string) {
    const { runTurn } = await import("../src/chat/turn");
    await runTurn(deps, conversationId, "你好", () => {}, new AbortController().signal);
  }

  test("chat turn 注入 global + 本成员 member 段；他成员段不进", async () => {
    ensureKnowledgeRepo();
    const root = knowledgeRoot();
    writeFileSync(join(root, "experience/global.md"), "通用：先给结论", "utf8");
    writeFileSync(join(root, "experience/members/u_m1.md"), "m1 喜欢简短回复", "utf8");
    writeFileSync(join(root, "experience/members/u_m2.md"), "m2 喜欢详尽报告", "utf8");

    const stub = stubStreamFactory([{ text: "好" }]);
    const { deps } = mkDeps(stub.factory);
    const conv = deps.store.createConversation({ id: "c_m1", workspaceId: "ws_company", userId: "u_m1" });
    await runChatTurn(deps, conv.id);
    const joined = (stub.calls[0].appendSystemPrompt ?? []).join("\n");
    expect(joined).toContain("先给结论"); // global
    expect(joined).toContain("m1 喜欢简短回复"); // 本成员
    expect(joined).not.toContain("m2 喜欢详尽报告"); // 他成员隔离
  });

  test("无经验文件 → 注入跳过，appendSystemPrompt 不含经验段", async () => {
    ensureKnowledgeRepo(); // 空态（未手写）
    const stub = stubStreamFactory([{ text: "好" }]);
    const { deps } = mkDeps(stub.factory);
    const conv = deps.store.createConversation({ id: "c_ux", workspaceId: "ws_company", userId: "u_x" });
    await runChatTurn(deps, conv.id);
    const joined = (stub.calls[0].appendSystemPrompt ?? []).join("\n");
    expect(joined).not.toContain("[通用经验]");
    expect(joined).not.toContain("[成员经验]");
  });
});
