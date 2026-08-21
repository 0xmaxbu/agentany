// R-6 P3（agentany-client issue #4 / ADR-0036）**集成层**（issue #9 双仓分层）：真 hyper-workflow 服务器 + 真 AgentClient + **真 macOS computer-use 桥**。
// 与 r6-e2e-client.test.ts 同构（serve port:0 + bridge /run/remote-tool + /files/device-upload），但执行器表用 allExecutors()
// （含 computer_use.screens/observe/act），桥走默认路径 ~/.agentany/bin/computeruse（scripts/build-cu-macos.sh 安装产物）。
// 环境级验证真实 AX / 真实截图（screen recording + accessibility 授权为本机已验证前置）；动作仅取无害子集（move → 鼠标到主屏中
// 心、wait 无动作），不点击任意真实元素。桥产物（截图 PNG）随 tool_result.artifacts 回传并断言服务器工作区真实落盘。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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
import { AgentClient, allExecutors } from "@agentany/device-core";

// 真桥门：AGENTANY_CU_BIN → ~/.agentany/bin/computeruse 存在才跑本 seam（非 macOS / 未安装桥时跳过，CI 不炸）。
const bridgeBin = process.env.AGENTANY_CU_BIN ?? join(homedir(), ".agentany", "bin", "computeruse");
const bridgePresent = (): boolean => existsSync(bridgeBin);

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const JH = { "content-type": "application/json" };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitOnline(agent: AgentClient, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (agent.getStatus() !== "online") {
    if (Date.now() - t0 > ms) throw new Error(`agent not online within ${ms}ms (status=${agent.getStatus()})`);
    await delay(20);
  }
}

describe.skipIf(!bridgePresent())("R-6 P3 · 集成层：真桥 computer-use round-trip（真实 AX / 真实截图）", () => {
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
  let wsRoot: string; // 服务器 run 工作区根（断言截图真实落盘）
  let devBase: string; // 设备侧隔离工作区

  beforeEach(async () => {
    db = openDbMigrated(":memory:");
    store = createStores(db);
    userStore = new UserStore(db);
    registry = new DeviceRegistry();
    const toolRpc = new DeviceToolRpc({ registry, timeoutMs: 15_000 });
    const lifecycleDeps: RunLifecycleDeps = { runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus: new EventBus(), remote: store.remote, runPiFactory: stubFactory };
    const runLifecycle = new RunLifecycle(lifecycleDeps);
    const deps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback,
      userStore, streamRegistry: new StreamRegistry(), workspaceStore: new WorkspaceStore(db),
      remote: store.remote, deviceRegistry: registry, runLifecycle,
    };
    process.env.SECURITY_POSTURE = "dangerous";
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token";
    // 截图部署配置：ext 默认走 JPEG 压缩（~350KB @全尺寸），h5 的 64KB JSON 守卫不变；回传面放宽到 4MB。
    process.env.MAX_BODY_BYTES = String(4 * 1024 * 1024);
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "r6cu-data-"));
    server = serve(createApp(deps), {
      port: 0, userStore, remote: store.remote, registry,
      onDeviceMessage: (entry, msg) => { toolRpc.route(entry, msg as Record<string, unknown>); },
      onDeviceClose: (entry) => { toolRpc.failAllForUser(entry.userId, `device disconnected (${entry.deviceId})`); },
    });
    bridge = createBridgeApp({
      runLifecycle, runStore: store.runs, chatStore: store.chat, userStore, toolRpc,
    });
    member = await userStore.createUser({ username: "m1", password: "password1" });
    convId = store.chat.createConversation({ id: "c-r6cu", workspaceId: "ws_company", userId: member.id }).id;
    runId = "r_test_p3";
    store.runs.createRun({ runId, workflowId: "synthetic-cu", workspaceId: "ws_company", conversationId: convId, input: {} });
    wsRoot = join(process.env.DATA_DIR!, "general", "workspace");

    devBase = mkdtempSync(join(tmpdir(), "r6cu-dev-"));
    const tok = await mTok();
    agent = new AgentClient({
      wsUrl: server.wsUrl("/ws/device"),
      token: tok,
      deviceId: "dev-r6cu",
      handlers: allExecutors(), // P2 五执行器 + computer_use 三件套
      workDir: (r) => join(devBase, r.replace(/[/\\:]/g, "_")),
      grantsDir: mkdtempSync(join(tmpdir(), "r6cu-grants-")), // 授权档隔离 + 借用类免弹窗（集成层放行）
      onConsent: async () => ({ action: "allow_once" }),
    });
    agent.connect();
    await waitOnline(agent);
  });
  afterEach(() => {
    agent.stop();
    delete process.env.SECURITY_POSTURE;
    delete process.env.AGENTANY_DEV_TOKEN;
    delete process.env.MAX_BODY_BYTES;
    delete process.env.DATA_DIR;
    server.close();
  });

  // P5a：走设备登录（真客户端同路径——公开端点 device-login；/auth/login 是 web 会话登录）
  const mTok = async () => {
    const r = await fetch(server.url("/auth/device-login"), { method: "POST", headers: JH, body: JSON.stringify({ username: "m1", password: "password1", deviceId: "dev-r6cu" }) });
    return ((await r.json()) as { token: string }).token;
  };
  const invoke = async (tool: string, args: unknown) =>
    bridge.request("/run/remote-tool", {
      method: "POST",
      headers: { authorization: `Bearer ${issueRunNonce(runId, convId)}`, ...JH },
      body: JSON.stringify({ runId, tool, args }),
    });

  test("screens：真实 CGWindowList → 显示器与窗口列表（LLM 可读）", async () => {
    const r = await invoke("computer_use.screens", {});
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.stdout).toContain("displays: ");
    const n = Number((body.stdout as string).match(/displays: (\d+)/)?.[1] ?? "0");
    expect(n).toBeGreaterThanOrEqual(1); // 真实桌面至少一块主屏
    expect(body.stdout).toMatch(/windows: \d+/);
  });

  test("observe visual：真实截图 → 服务器 run 工作区真实落盘（PNG magic）", async () => {
    const r = await invoke("computer_use.observe", {});
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.stdout).toMatch(/stateId \d+/);
    expect(body.stdout).toContain("image ");
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].path).toMatch(new RegExp(`^runs/${runId}/s\\d+-observe-\\w+\\.(jpg|png)$`));
    const abs = join(wsRoot, body.artifacts[0].path as string);
    expect(existsSync(abs)).toBe(true);
    // 默认 JPEG 压缩（ADR-0036：内容清晰即够，服务不收原尺寸）——产物为真实 JPEG
    const magic = readFileSync(abs).subarray(0, 3).toString("hex");
    expect(magic).toBe("ffd8ff");
  });

  test("observe visual+ax：真实 AX outline（ref 引用可取）", async () => {
    // 前台应用决定 AX 面：Chromium 系（Brave 等）默认不暴露 AX 树（2026-08-21 实测 count=0 → outline=null）。
    // 置前必有原生 AX 的 Finder，消除环境抖动（桥按 NSWorkspace.frontmostApplication 建账）。
    Bun.spawnSync(["osascript", "-e", 'tell application "Finder" to activate']);
    await delay(500);
    const r = await invoke("computer_use.observe", { mode: "visual+ax" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.stdout).toContain("AX outline ✓"); // outline 树非空才报"可取"
  });

  test("act 无害动作（move → 主屏中心 + wait）：真实 CGEvent + 后置截图 artifact", async () => {
    await invoke("computer_use.observe", {}); // 取坐标视野（stateId 契约）
    const r = await invoke("computer_use.act", { action: { type: "move" }, x: 512, y: 288 });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.stdout).toContain("新 stateId");
    expect(body.artifacts).toHaveLength(1); // 后置截图 artifact
    expect(body.artifacts[0].path).toMatch(new RegExp(`^runs/${runId}/s\\d+-after-\\w+\\.(jpg|png)$`));
    // 无动作兜底：wait 空转不产生副作用、可连续调用
    const r2 = await invoke("computer_use.act", { action: { type: "wait" }, ms: 50 });
    const b2 = (await r2.json()) as any;
    expect(b2.ok).toBe(true);
  });
});