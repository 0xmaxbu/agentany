// R-6 P2（agentany-client issue #3 / ADR-0036）**集成层**（issue #9 双仓分层，2026-08-21 起）：真客户端端到端 round-trip。
// 真实 hyper-workflow 服务器（serve port:0 + bridge + /files/device-upload）+ **真 AgentClient**（@agentany/device-core，
// P2 五执行器）——替代 r5 的脚本化 FakeDevice。触发路径：workflow 声明 tools → stub（R-5）→ bridge /run/remote-tool
// → WS tool_call → 真客户端本地执行 → tool_result + artifacts 回传 → 断言 stdout/exit code/文件落盘。
// 单测层已下沉两仓 mock（client 仓 @agentany/mock-server / 本仓 FakeDevice 系）——真+真只在本层，
// 本层同时是 mock 漂移的契约锚（协议改动 → mock 与真实现同改，此处兜底）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createBridgeApp } from "../src/bridge/server";
import { openDbMigrated } from "../src/db/client";
import { createStores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { WorkspaceStore } from "../src/workspaces/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { EventBus } from "../src/chat/eventbus";
import { RunLifecycle, type RunLifecycleDeps } from "../src/runs/lifecycle";
import { serve, type ServerHandle } from "../src/device/server";
import { DeviceRegistry } from "../src/device/registry";
import { DeviceToolRpc } from "../src/device/tool";
import { issueRunNonce } from "../src/bridge/nonce";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";
import { AgentClient, defaultExecutors, writeGrants } from "@agentany/device-core";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const JH = { "content-type": "application/json" };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 真客户端连接并等 online（硬时限防挂死）。 */
async function waitOnline(agent: AgentClient, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (agent.getStatus() !== "online") {
    if (Date.now() - t0 > ms) throw new Error(`agent not online within ${ms}ms (status=${agent.getStatus()})`);
    await delay(20);
  }
}

describe("R-6 P2 · 集成层：真客户端五执行器 round-trip（真服务器+真客户端）", () => {
  let db: ReturnType<typeof openDbMigrated>;
  let store: ReturnType<typeof createStores>;
  let userStore: UserStore;
  let registry: DeviceRegistry;
  let server: ServerHandle;
  let bridge: ReturnType<typeof createBridgeApp>;
  let agent: AgentClient;
  let member: Awaited<ReturnType<UserStore["createUser"]>>;
  let convId: string;
  let runId: string;
  let wsRoot: string; // 服务器 run 工作区根（断言产物落盘）
  let devBase: string; // 设备侧工作区根（被测客户端用；隔离于主 checkout）

  beforeEach(async () => {
    db = openDbMigrated(":memory:");
    store = createStores(db);
    userStore = new UserStore(db);
    registry = new DeviceRegistry();
    const toolRpc = new DeviceToolRpc({ registry, timeoutMs: 10_000 });
    const lifecycleDeps: RunLifecycleDeps = { runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus: new EventBus(), remote: store.remote, runPiFactory: stubFactory };
    const runLifecycle = new RunLifecycle(lifecycleDeps);
    const deps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback,
      userStore, streamRegistry: new StreamRegistry(), workspaceStore: new WorkspaceStore(db),
      remote: store.remote, deviceRegistry: registry, runLifecycle,
    };
    process.env.SECURITY_POSTURE = "dangerous";
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token";
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "r6-data-"));
    server = serve(createApp(deps), {
      port: 0, userStore, remote: store.remote, registry,
      onDeviceMessage: (entry, msg) => { toolRpc.route(entry, msg as Record<string, unknown>); },
      onDeviceClose: (entry) => { toolRpc.failAllForUser(entry.userId, `device disconnected (${entry.deviceId})`); },
    });
    bridge = createBridgeApp({
      runLifecycle, runStore: store.runs, chatStore: store.chat, userStore, toolRpc,
    });
    member = await userStore.createUser({ username: "m1", password: "password1" });
    convId = store.chat.createConversation({ id: "c-r6", workspaceId: "ws_company", userId: member.id }).id;
    runId = "r_test_p2";
    store.runs.createRun({ runId, workflowId: "synthetic-3step", workspaceId: "ws_company", conversationId: convId, input: {} });
    wsRoot = join(process.env.DATA_DIR!, "general", "workspace");

    // 真客户端：五执行器、真实上传（走 server.url()/files/device-upload）、隔离设备工作区
    devBase = mkdtempSync(join(tmpdir(), "r6-dev-"));
    const tok = await mTok();
    agent = new AgentClient({
      wsUrl: server.wsUrl("/ws/device"),
      token: tok,
      deviceId: "dev-r6",
      handlers: defaultExecutors(),
      workDir: (r) => join(devBase, r.replace(/[/\\:]/g, "_")),
      grantsDir: mkdtempSync(join(tmpdir(), "r6-grants-")), // 授权档隔离（P5b：不读真 HOME）
    });
    agent.connect();
    await waitOnline(agent);
  });
  afterEach(() => {
    agent.stop(); // 关真客户端（防重连定时器滞留）
    delete process.env.SECURITY_POSTURE;
    delete process.env.AGENTANY_DEV_TOKEN;
    delete process.env.DATA_DIR;
    server.close();
  });

  // P5a：走设备登录（真客户端同路径——公开端点 device-login；/auth/login 是 web 会话登录）
  const mTok = async () => {
    const r = await fetch(server.url("/auth/device-login"), { method: "POST", headers: JH, body: JSON.stringify({ username: "m1", password: "password1", deviceId: "dev-r6" }) });
    return ((await r.json()) as { token: string }).token;
  };
  const invoke = async (tool: string, args: unknown) =>
    bridge.request("/run/remote-tool", {
      method: "POST",
      headers: { authorization: `Bearer ${issueRunNonce(runId, convId)}`, ...JH },
      body: JSON.stringify({ runId, tool, args }),
    });

  test("bash round-trip：真客户端执行 → stdout 回给桥（LLM 面）", async () => {
    const r = await invoke("bash", { command: "echo r6-ok" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body).toMatchObject({ ok: true, code: 0 });
    expect(body.stdout).toContain("r6-ok");
  });

  test("bash 非零退出 → 真实 exit code 回传（agent 可据 stderr 止损）", async () => {
    const r = await invoke("bash", { command: "echo bad >&2; exit 3" });
    const body = (await r.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe(3);
    expect(body.stderr).toContain("bad");
  });

  test("write → 真客户端写设备文件 + 上传 → 服务器 run 工作区落盘（相对路径回传）", async () => {
    const r = await invoke("write", { path: "notes/report.txt", content: "r6-body" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({ name: "report.txt", path: `runs/${runId}/report.txt` });
    // 设备本地真实写了
    expect(readFileSync(join(devBase, runId.replace(/[/\\:]/g, "_"), "notes", "report.txt"), "utf8")).toBe("r6-body");
    // 服务器工作区真实落盘（相对路径可直接取回预览）
    expect(existsSync(join(wsRoot, body.artifacts[0].path))).toBe(true);
    expect(readFileSync(join(wsRoot, body.artifacts[0].path), "utf8")).toBe("r6-body");
  });

  test("read：write 后的文件回读（设备工作区基准）", async () => {
    await invoke("write", { path: "note.txt", content: "l1\nl2\nl3" });
    const r = await invoke("read", { path: "note.txt", offset: 1, limit: 2 });
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.stdout).toBe("l2\nl3");
  });

  test("edit 字符串替换 + 改动产物上传", async () => {
    await invoke("write", { path: "draft.txt", content: "hello world" });
    const r = await invoke("edit", { path: "draft.txt", old: "world", new: "agentany" });
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.artifacts[0]).toMatchObject({ name: "draft.txt", path: `runs/${runId}/draft.txt` });
    // 设备侧真实改 + 服务器侧上传到的新内容
    expect(readFileSync(join(wsRoot, body.artifacts[0].path), "utf8")).toBe("hello agentany");
  });

  test("grep：在设备工作区递归查找（含文件名）", async () => {
    await invoke("write", { path: "src/util.ts", content: "const token = 'r6-marker';" });
    const r = await invoke("grep", { pattern: "r6-marker" });
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.stdout).toContain("util.ts");
    expect(body.stdout).toContain("r6-marker");
  });

  test("unknown tool（服务端未注册）→ 400（设备不执行、桥把关）", async () => {
    const r = await invoke("no_such_tool", {});
    expect(r.status).toBe(400);
  });

  test("bash cwd 相对路径 → 以设备 run 工作区为基准", async () => {
    await invoke("write", { path: "sub/here.txt", content: "sub-dir" });
    const r = await invoke("bash", { command: "cat sub/here.txt", cwd: "." });
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.stdout).toContain("sub-dir");
  });

  test("P5b/ADR-0038 锚：tool_call 帧带 workflowId + 设备 deny 规则 → 透传 code:denied（不中止）", async () => {
    // 独立授权档：synthetic-3step × bash 显式 deny——规则能命中即证明真服务端按 run 补了 workflowId（D2）
    const grantsDir = mkdtempSync(join(tmpdir(), "r6-grants-deny-"));
    writeGrants({ version: 1, rules: [{ workflowId: "synthetic-3step", tool: "bash", policy: "deny" }] }, { dir: grantsDir });
    const agent2 = new AgentClient({
      wsUrl: server.wsUrl("/ws/device"),
      token: await mTok(),
      deviceId: "dev-r6-c", // 顶掉 beforeEach 的 dev-r6（单机顶号）——本测试专用连接
      handlers: defaultExecutors(),
      workDir: (r) => join(devBase, r.replace(/[/\\:]/g, "_")),
      grantsDir,
    });
    agent2.connect();
    await waitOnline(agent2);
    const r = await invoke("bash", { command: "echo denied-path" });
    expect(r.status).toBe(200); // deny ≠ 桥层错误（工具级失败透传，ADR-0038 D6）
    const body = (await r.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe("denied");
    expect(body.error).toContain("denied by device user");
    // 连接仍在：放行一次同连接调用（规则只 deny bash）——write 默认放行
    const r2 = await invoke("write", { path: "after-deny.txt", content: "alive" });
    const body2 = (await r2.json()) as any;
    expect(body2.ok).toBe(true);
    agent2.stop();
  });
});