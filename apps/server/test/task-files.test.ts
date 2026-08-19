// #30/M4-3b 产出文件收集 + 文件服务路由。
// seam ①直构（executeTask + stub stream 回放 tool_use block）→ task_files 登记；
// seam ②HTTP（createApp + 真文件落 ws 目录）→ GET /files/<ws>/<rel> 鉴权/逃逸/下载头；
// seam ③HTTP → GET /conversations/:id/files 分组（产出消息尾文件列表数据源）。
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores, type Stores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { WorkspaceStore } from "../src/workspaces/store";
import { EventBus } from "../src/chat/eventbus";
import { ConversationQueues } from "../src/chat/queue";
import { ScheduledTaskStore } from "../src/scheduled-tasks/store";
import { makeExecuteTask } from "../src/scheduled-tasks/execute";
import { wsRelativePath } from "../src/scheduled-tasks/files";
import { resolveScopePaths, scopeOf } from "../src/scope";
import type { RunDeps } from "../src/runs";
import type { StreamBlock } from "../src/blocks";

const JH = { "content-type": "application/json" };

// ── 共用装配 ──
async function setup() {
  const db = openDbMigrated(":memory:");
  const store = createStores(db);
  const userStore = new UserStore(db);
  await userStore.createUser({ username: "m1", password: "pw-long-enough", role: "member" });
  const m1 = userStore.getUserByUsername("m1")!;
  await userStore.createUser({ username: "ad", password: "pw-long-enough", role: "admin" });
  const ad = userStore.getUserByUsername("ad")!;
  const deps: RunDeps = {
    runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore, streamRegistry: new StreamRegistry(),
    workspaceStore: new WorkspaceStore(db),
    taskStore: new ScheduledTaskStore(db, store.chat),
    eventBus: new EventBus(),
  };
  const app = createApp(deps);
  const login = async (u: string) => {
    const r = await app.request("/auth/login", { method: "POST", headers: JH, body: JSON.stringify({ username: u, password: "pw-long-enough" }) });
    return `Bearer ${(await r.json() as any).token}`;
  };
  return { deps, store, userStore, app, m1, ad, login };
}

// ── stub stream：回放 blocks + 可选文本（execute seam 用）──
function stubStreamFactory(results: Array<{ text?: string; blocks?: StreamBlock[]; error?: Error }>) {
  const calls: any[] = [];
  const factory = (opts: { extensions?: string[] }) => {
    return async (call: any) => {
      calls.push({ prompt: call.prompt, extensions: opts.extensions, appendSystemPrompt: call.appendSystemPrompt });
      const r = results[Math.min(calls.length - 1, results.length - 1)];
      if (r?.error) throw r.error;
      for (const b of r?.blocks ?? []) call.onBlock?.(b);
      return { text: r?.text ?? "产出", messages: [], toolResults: [] };
    };
  };
  return { factory, calls };
}

const toolUseStart = (blockId: string, name: string, args: Record<string, unknown>): StreamBlock => ({
  op: "start", blockId, kind: "tool_use", meta: { toolCallId: blockId, name, arguments: args },
});
const blockEnd = (blockId: string): StreamBlock => ({ op: "end", blockId });

// ═══ 单元：wsRelativePath 归一 + 防逃逸 ═══
describe("wsRelativePath（路径归一纯函数）", () => {
  const cwd = resolve("/tmp/ws_root");

  test("相对路径直通（POSIX 化）", () => {
    expect(wsRelativePath(cwd, "report.md")).toBe("report.md");
    expect(wsRelativePath(cwd, "out/汇总.pdf")).toBe("out/汇总.pdf");
    expect(wsRelativePath(cwd, "./out/x.md")).toBe("out/x.md");
  });

  test("cwd 内绝对路径 → 相对化", () => {
    expect(wsRelativePath(cwd, join(cwd, "out/x.md"))).toBe("out/x.md");
  });

  test("逃逸（../ 出 cwd / 外部绝对路径）→ undefined 不登记", () => {
    expect(wsRelativePath(cwd, "../secret.txt")).toBeUndefined();
    expect(wsRelativePath(cwd, "out/../../escape.md")).toBeUndefined();
    expect(wsRelativePath(cwd, "/etc/passwd")).toBeUndefined();
  });
});

// ═══ 收集：executeTask 钩 tool_use → task_files ═══
describe("executeTask 产出文件收集（#30）", () => {
  test("write/edit 工具路径 → task_files 登记（runId 关联、去重、归一）；逃逸路径跳过", async () => {
    const stub = stubStreamFactory([{
      text: "产出完成",
      blocks: [
        toolUseStart("t1", "write", { path: "out/news-digest.md", content: "x" }), blockEnd("t1"),
        toolUseStart("t2", "edit", { path: "out/news-digest.md", edits: [] }), blockEnd("t2"), // 同文件二次操作 → 去重
        toolUseStart("t3", "write", { path: "out/data.csv", content: "y" }), blockEnd("t3"),
        toolUseStart("t4", "write", { path: "../escape.txt", content: "z" }), blockEnd("t4"), // 逃逸 → 不登记
        toolUseStart("t5", "read", { path: "out/news-digest.md" }), blockEnd("t5"), // 非写类 → 不登记
        toolUseStart("t6", "bash", { command: "echo hi" }), blockEnd("t6"),
      ],
    }]);
    const db = openDbMigrated(":memory:");
    const store = createStores(db);
    const deps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore: new UserStore(db), streamRegistry: new StreamRegistry(),
      workspaceStore: new WorkspaceStore(db),
      taskStore: new ScheduledTaskStore(db, store.chat), eventBus: new EventBus(),
      runPiStreamFactory: stub.factory as any,
    };
    const task = deps.taskStore!.createWorkspaceTask({
      displayName: "新闻汇总", cron: "0 */4 * * *", prompt: "读新闻写文件",
      workspaceId: "ws_company", creatorId: "u_test", firstFireAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const executeTask = makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! });
    await executeTask(task, "cron");
    await new Promise((r) => setTimeout(r, 30));

    const runs = deps.taskStore!.listRuns(task.id);
    expect(runs).toHaveLength(1);
    const files = deps.taskStore!.listTaskFiles(String(runs[0].id));
    expect(files.map((f) => f.path).sort()).toEqual(["out/data.csv", "out/news-digest.md"]); // 去重 + 逃逸/非写类剔除
    expect(files.every((f) => f.taskRunId === String(runs[0].id))).toBe(true);
    // name = basename（下载显示名）
    expect(files.find((f) => f.path === "out/news-digest.md")!.name).toBe("news-digest.md");
  });

  test("无 write 类工具 → task_files 空", async () => {
    const stub = stubStreamFactory([{ text: "只有文本", blocks: [toolUseStart("t1", "read", { path: "a.md" }), blockEnd("t1")] }]);
    const db = openDbMigrated(":memory:");
    const store = createStores(db);
    const deps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback, userStore: new UserStore(db), streamRegistry: new StreamRegistry(),
      workspaceStore: new WorkspaceStore(db),
      taskStore: new ScheduledTaskStore(db, store.chat), eventBus: new EventBus(),
      runPiStreamFactory: stub.factory as any,
    };
    const task = deps.taskStore!.createWorkspaceTask({
      displayName: "T", cron: "0 */4 * * *", prompt: "p",
      workspaceId: "ws_company", creatorId: "u_test", firstFireAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await makeExecuteTask({ deps, queues: new ConversationQueues(), eventBus: deps.eventBus! })(task, "cron");
    await new Promise((r) => setTimeout(r, 20));
    const runs = deps.taskStore!.listRuns(task.id);
    expect(deps.taskStore!.listTaskFiles(String(runs[0].id))).toHaveLength(0);
  });
});

// ═══ HTTP：GET /files/<ws>/<rel>（真文件落盘）═══
describe("GET /files/:workspaceId/:path（#30 文件服务）", () => {
  // ws_company 的真目录锚（scope.ts 真相——不硬编码路径）
  const WS_DIR = resolveScopePaths(scopeOf("ws_company"), "ws_company").cwd;
  const TEST_DIR = join(WS_DIR, "task-files-test");
  const MD = join(TEST_DIR, "digest.md");
  const PDF = join(TEST_DIR, "report.pdf");
  const BIN = join(TEST_DIR, "data.bin");

  beforeEach(async () => {
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token"; // auth 强制态（=prod）：未登录 401 断言依赖
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(MD, "# 摘要\n正文");
    writeFileSync(PDF, "%PDF-1.4 fake");
    writeFileSync(BIN, new Uint8Array([0, 1, 2]));
  });

  afterEach(() => {
    delete process.env.AGENTANY_DEV_TOKEN; // 防泄漏到同进程其它测试文件（auth.test 同款纪律）
  });

  afterAll(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  test("ws 可见用户（admin）取 md → 200 text/markdown inline", async () => {
    const ctx = await setup();
    const tok = await ctx.login("ad");
    const r = await ctx.app.request(`/files/ws_company/task-files-test/digest.md`, { headers: { authorization: tok } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/markdown");
    expect(r.headers.get("content-disposition")).toContain("inline");
    expect(await r.text()).toContain("# 摘要");
  });

  test("?download=1 → attachment + 文件名", async () => {
    const ctx = await setup();
    const tok = await ctx.login("ad");
    const r = await ctx.app.request(`/files/ws_company/task-files-test/digest.md?download=1`, { headers: { authorization: tok } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("attachment");
    expect(r.headers.get("content-disposition")).toContain("digest.md");
  });

  test("路径逃逸（%2e%2e/ 与编码变体）→ 404", async () => {
    const ctx = await setup();
    const tok = await ctx.login("ad");
    const paths = [
      "/files/ws_company/../server/src/app.ts",
      "/files/ws_company/task-files-test/../../package.json",
      "/files/ws_company/%2e%2e/package.json",
    ];
    for (const p of paths) {
      const r = await ctx.app.request(p, { headers: { authorization: tok } });
      expect(r.status).toBe(404);
    }
  });

  test("不存在的 ws / 不存在的文件 → 404（不泄漏存在）", async () => {
    const ctx = await setup();
    const tok = await ctx.login("ad");
    expect((await ctx.app.request("/files/ws_none/x.md", { headers: { authorization: tok } })).status).toBe(404);
    expect((await ctx.app.request("/files/ws_company/task-files-test/nope.md", { headers: { authorization: tok } })).status).toBe(404);
  });

  test("目录路径 → 404（review-c2：非普通文件不当流回）", async () => {
    const ctx = await setup();
    const tok = await ctx.login("ad");
    const r = await ctx.app.request("/files/ws_company/task-files-test", { headers: { authorization: tok } });
    expect(r.status).toBe(404);
  });

  test("未登录 → 401", async () => {
    const ctx = await setup();
    expect((await ctx.app.request("/files/ws_company/task-files-test/digest.md")).status).toBe(401);
  });

  test("pdf/bin 的 content-type 与默认 octet-stream", async () => {
    const ctx = await setup();
    const tok = await ctx.login("ad");
    const pdf = await ctx.app.request(`/files/ws_company/task-files-test/report.pdf`, { headers: { authorization: tok } });
    expect(pdf.headers.get("content-type")).toContain("application/pdf");
    const bin = await ctx.app.request(`/files/ws_company/task-files-test/data.bin`, { headers: { authorization: tok } });
    expect(bin.headers.get("content-type")).toContain("application/octet-stream");
  });

  test("无 ws 访问权的 member → 404（建私有 ws，m1 不在名单）", async () => {
    const ctx = await setup();
    // 建私有 ws（admin）+ 文件（scope 解析的真目录）
    const created = await ctx.app.request("/workspaces", { method: "POST", headers: { ...JH, authorization: await ctx.login("ad") }, body: JSON.stringify({ name: "私密" }) });
    const wsId = ((await created.json()) as any).id;
    const wsDir = resolveScopePaths(scopeOf(wsId), wsId).cwd;
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "secret.md"), "秘密");
    const tokM1 = await ctx.login("m1");
    expect((await ctx.app.request(`/files/${wsId}/secret.md`, { headers: { authorization: tokM1 } })).status).toBe(404);
    // admin 全通
    const tokAd = await ctx.login("ad");
    expect((await ctx.app.request(`/files/${wsId}/secret.md`, { headers: { authorization: tokAd } })).status).toBe(200);
  });
});

// ═══ HTTP：GET /conversations/:id/files（产出消息尾文件列表数据源）═══
describe("GET /conversations/:id/files（#30 文件列表）", () => {
  test("产出会话 → 按 run 分组（outputMessageId 锚消息尾）；他人会话 404", async () => {
    const ctx = await setup();
    // 手工搭：任务 + 产出会话 + run 行 + 文件行（execute 链已在上面测过，此处测 API 形状）
    const task = ctx.deps.taskStore!.createWorkspaceTask({
      displayName: "T", cron: "0 */4 * * *", prompt: "p",
      workspaceId: "ws_company", creatorId: ctx.m1.id, firstFireAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const runId = ctx.deps.taskStore!.recordRun({ taskId: task.id, trigger: "cron", status: "ok" });
    ctx.deps.taskStore!.finishRun(runId, { status: "ok", outputMessageId: "42" });
    ctx.deps.taskStore!.addTaskFile({ taskRunId: String(runId), path: "out/digest.md", name: "digest.md" });

    const tok = await ctx.login("m1");
    const r = await ctx.app.request(`/conversations/${task.outputConversationId}/files`, { headers: { authorization: tok } });
    expect(r.status).toBe(200);
    const groups = (await r.json()) as any[];
    expect(groups).toHaveLength(1);
    expect(groups[0].outputMessageId).toBe("42");
    expect(groups[0].files.map((f: any) => f.path)).toEqual(["out/digest.md"]);

    // 他人（member）不可见该会话 → 404
    await ctx.userStore.createUser({ username: "m2", password: "pw-long-enough", role: "member" });
    const tokM2 = await ctx.login("m2");
    expect((await ctx.app.request(`/conversations/${task.outputConversationId}/files`, { headers: { authorization: tokM2 } })).status).toBe(404);
    // admin 可见
    const tokAd = await ctx.login("ad");
    expect((await ctx.app.request(`/conversations/${task.outputConversationId}/files`, { headers: { authorization: tokAd } })).status).toBe(200);
  });
});
