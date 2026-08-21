// R-6 P4（agentany-client issue #5 / ADR-0035 修订）真 Chrome seam：真 hyper-workflow 服务器 + 真 AgentClient
// + **真 Chrome**（headless=new + 一次性 tmp profile——生产姿态是有头 + 持久 profile，headless 是 seam 显式例外）。
// 与 r6-computer-use.test.ts 同构（serve port:0 + bridge /run/remote-tool + /files/device-upload），
// 执行器表用 allExecutors()（含 browser 六件套）。页面用 data: URL（无外网依赖）；
// click/type 效果经 DOM 属性回读断言（isolated world 与主世界共享 DOM——window expando 不共享，故不用 window 变量）。
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
import { AgentClient, allExecutors, resetBrowserForTests } from "@agentany/device-core";

// 真Chrome门：AGENTANY_BROWSER_BIN → 平台默认路径存在才跑（无 Chrome 环境跳过，CI 不炸）。
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const chromeBin = process.env.AGENTANY_BROWSER_BIN ?? CHROME_CANDIDATES.find((p) => existsSync(p));
const chromePresent = (): boolean => !!chromeBin;

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

// data: 页面：标题 + 输入框 + 固定定位大按钮（headless 视口内坐标确定性）
const PAGE =
  "data:text/html,<title>Seam Test</title>" +
  '<input id="q">' +
  '<button id="b" onclick="this.dataset.c=1" style="position:fixed;left:0;top:0;width:300px;height:150px">B</button>';

describe.skipIf(!chromePresent())("R-6 P4 · 真 Chrome browser round-trip（headless seam，主 seam）", () => {
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

  beforeEach(async () => {
    db = openDbMigrated(":memory:");
    store = createStores(db);
    userStore = new UserStore(db);
    registry = new DeviceRegistry();
    const toolRpc = new DeviceToolRpc({ registry, timeoutMs: 30_000 }); // 首调含 Chrome 冷启动
    const lifecycleDeps: RunLifecycleDeps = { runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus: new EventBus(), remote: store.remote, runPiFactory: stubFactory };
    const runLifecycle = new RunLifecycle(lifecycleDeps);
    const deps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback,
      userStore, streamRegistry: new StreamRegistry(), workspaceStore: new WorkspaceStore(db),
      remote: store.remote, deviceRegistry: registry, runLifecycle,
    };
    process.env.SECURITY_POSTURE = "dangerous";
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token";
    process.env.MAX_BODY_BYTES = String(4 * 1024 * 1024); // 截图回传面（h5 64KB JSON 守卫不变，沿 P3 部署契约）
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "r6br-data-"));
    server = serve(createApp(deps), {
      port: 0, userStore, remote: store.remote, registry,
      onDeviceMessage: (entry, msg) => { toolRpc.route(entry, msg as Record<string, unknown>); },
      onDeviceClose: (entry) => { toolRpc.failAllForUser(entry.userId, `device disconnected (${entry.deviceId})`); },
    });
    bridge = createBridgeApp({
      runLifecycle, runStore: store.runs, chatStore: store.chat, userStore, toolRpc,
    });
    member = await userStore.createUser({ username: "m1", password: "password1" });
    convId = store.chat.createConversation({ id: "c-r6br", workspaceId: "ws_company", userId: member.id }).id;
    runId = "r_test_p4";
    store.runs.createRun({ runId, workflowId: "synthetic-cu", workspaceId: "ws_company", conversationId: convId, input: {} });
    wsRoot = join(process.env.DATA_DIR!, "general", "workspace");

    // 浏览器后端环境：真 Chrome + 一次性 profile + headless（seam 显式例外；生产=有头+持久 profile）
    process.env.AGENTANY_BROWSER_BIN = chromeBin!;
    process.env.AGENTANY_BROWSER_PROFILE = mkdtempSync(join(tmpdir(), "r6br-profile-"));
    process.env.AGENTANY_BROWSER_HEADLESS = "1";
    resetBrowserForTests();

    const devBase = mkdtempSync(join(tmpdir(), "r6br-dev-"));
    const tok = await mTok();
    agent = new AgentClient({
      wsUrl: server.wsUrl("/ws/device"),
      token: tok,
      deviceId: "dev-r6br",
      handlers: allExecutors(), // 五执行器 + computer-use 三件套 + browser 六件套
      workDir: (r) => join(devBase, r.replace(/[/\\:]/g, "_")),
    });
    agent.connect();
    await waitOnline(agent);
  });
  afterEach(() => {
    agent.stop();
    resetBrowserForTests(); // 杀 Chrome（自启进程随测试清理）
    delete process.env.SECURITY_POSTURE;
    delete process.env.AGENTANY_DEV_TOKEN;
    delete process.env.MAX_BODY_BYTES;
    delete process.env.DATA_DIR;
    delete process.env.AGENTANY_BROWSER_BIN;
    delete process.env.AGENTANY_BROWSER_PROFILE;
    delete process.env.AGENTANY_BROWSER_HEADLESS;
    server.close();
  });

  const mTok = async () => {
    const r = await fetch(server.url("/auth/login"), { method: "POST", headers: JH, body: JSON.stringify({ username: "m1", password: "password1" }) });
    return ((await r.json()) as { token: string }).token;
  };
  const invoke = async (tool: string, args: unknown) =>
    bridge.request("/run/remote-tool", {
      method: "POST",
      headers: { authorization: `Bearer ${issueRunNonce(runId, convId)}`, ...JH },
      body: JSON.stringify({ runId, tool, args }),
    });

  test("tabs + navigate + evaluate：真实页面加载，隔离世界读 document.title", async () => {
    const t = await invoke("browser.tabs", {});
    expect(t.status).toBe(200);
    const tb = (await t.json()) as any;
    expect(tb.ok).toBe(true);
    expect(tb.stdout).toContain("tabs: ");

    const n = await invoke("browser.navigate", { url: PAGE });
    expect(n.status).toBe(200);
    const nb = (await n.json()) as any;
    expect(nb.ok).toBe(true);
    expect(nb.stdout).toContain("navigate ok");

    const e = await invoke("browser.evaluate", { expression: "document.title" });
    const eb = (await e.json()) as any;
    expect(eb.ok).toBe(true);
    expect(eb.stdout).toContain("Seam Test");
  });

  test("click：插值轨迹点击固定定位按钮 → DOM dataset 生效", async () => {
    await invoke("browser.navigate", { url: PAGE });
    const c = await invoke("browser.click", { x: 150, y: 75 });
    expect(c.status).toBe(200);
    const cb = (await c.json()) as any;
    expect(cb.ok).toBe(true);
    expect(cb.stdout).toContain("(150, 75)");

    const e = await invoke("browser.evaluate", { expression: "document.getElementById('b').dataset.c" });
    const eb = (await e.json()) as any;
    expect(eb.ok).toBe(true);
    expect(eb.stdout).toContain("1");
  });

  test("type：focus 后逐字符键入 → input.value 回读", async () => {
    await invoke("browser.navigate", { url: PAGE });
    await invoke("browser.evaluate", { expression: "document.getElementById('q').focus()" });
    const t = await invoke("browser.type", { text: "hi agentany" });
    expect(t.status).toBe(200);
    const tb = (await t.json()) as any;
    expect(tb.ok).toBe(true);
    expect(tb.stdout).toContain("11 chars");

    const e = await invoke("browser.evaluate", { expression: "document.getElementById('q').value" });
    const eb = (await e.json()) as any;
    expect(eb.ok).toBe(true);
    expect(eb.stdout).toContain("hi agentany");
  });

  test("screenshot：页面视口 JPEG → 服务器 run 工作区真实落盘", async () => {
    await invoke("browser.navigate", { url: PAGE });
    const s = await invoke("browser.screenshot", {});
    expect(s.status).toBe(200);
    const sb = (await s.json()) as any;
    expect(sb.ok).toBe(true);
    expect(sb.artifacts).toHaveLength(1);
    expect(sb.artifacts[0].path).toMatch(new RegExp(`^runs/${runId}/s\\d+-shot\\.jpg$`));
    const abs = join(wsRoot, sb.artifacts[0].path as string);
    expect(existsSync(abs)).toBe(true);
    // 约定沿 P3：内容清晰即够——页面截图 JPEG 压缩
    const magic = readFileSync(abs).subarray(0, 3).toString("hex");
    expect(magic).toBe("ffd8ff");
  });
});
