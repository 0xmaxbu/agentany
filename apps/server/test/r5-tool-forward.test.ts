// R-5（#77 / ADR-0033）验收：只测外部行为——
// ① stub 生成：schema.ts→TypeBox 桥、remote 工具扩展产物、ctxFor 叠加注入（仅含 remote 工具时注入桥环境）
// ② 转发往返：bridge /run/remote-tool（run 级 nonce）→ 设备收 tool_call（含 schema/args）→ 回 tool_result →
//    bridge 返回结构化结果给 pi stub
// ③ 归属/校验守卫：bad nonce 401、run 不匹配 403、非 remote 工具 400、参数校验 400
// ④ 失败语义：设备离线 → ok:false device_offline；在飞断连 → device_disconnected；超时 → tool_timeout
// ⑤ 文件回传：设备上传落 run 工作区（相对路径回归 tool_result.artifacts）；非所有者 403
// ⑥ 非 remote 工作流零注入（runBridge 不设 / 无 stub）——回归护栏
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync, readFileSync } from "node:fs";
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
import { schemaToTypeBox, writeStubExtension } from "../src/device/stub";
import { FakeDevice } from "./device-ws";
import { getWorkflow } from "../src/registry";
import { defineWorkflow } from "../src/workflow-engine/defineWorkflow";
import { schema } from "../src/workflow-engine/schema";
import { issueRunNonce } from "../src/bridge/nonce";
import type { MakeRunPiOpts } from "../src/pi/runPi-factory";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";
import { eq } from "drizzle-orm";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const JH = { "content-type": "application/json" };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 远程工具 fixture（对应 registry 里的 device_shell，remote:true）
const remoteWf = defineWorkflow({ id: "remote-device-wf", tools: ["device_shell"] })
  .step("s1", {
    async execute() {
      return { done: true };
    },
  })
  .commit();

describe("R-5 · stub 生成（schema 桥 + 注入）", () => {
  test("schemaToTypeBox：全原语映射到 TypeBox 代码文本", () => {
    const s = schemaToTypeBox(
      schema.object({
        query: schema.string(),
        n: schema.optional(schema.number()),
        tags: schema.array(schema.enum("a", "b")),
      }),
    );
    expect(s).toContain("Type.String()");
    expect(s).toContain("Type.Optional(Type.Number())");
    expect(s).toContain("Type.Array(Type.Union([Type.Literal(\"a\"), Type.Literal(\"b\")]))");
  });

  test("writeStubExtension：产物含工具名 + 转发 handler，无本地执行逻辑", () => {
    const p = writeStubExtension("device_shell", schema.object({ command: schema.string() }), "r_test_1");
    const content = readFileSync(p, "utf8");
    expect(content).toContain('name: "device_shell"');
    expect(content).toContain("Type.String()");
    expect(content).toContain("/run/remote-tool");
    expect(content).toContain("AGENTANY_RUN_ID");
    expect(content).not.toContain("exec("); // 无本地执行
  });
});

describe("R-5 · ctxFor 注入（仅含 remote 工具时）", () => {
  let db: ReturnType<typeof openDbMigrated>;
  let store: ReturnType<typeof createStores>;
  let userStore: UserStore;
  let lifecycle: RunLifecycle;
  let captured: MakeRunPiOpts | null = null;
  let server: ServerHandle;
  let member: Awaited<ReturnType<UserStore["createUser"]>>;

  beforeEach(async () => {
    db = openDbMigrated(":memory:");
    store = createStores(db);
    userStore = new UserStore(db);
    captured = null;
    const deps: RunLifecycleDeps = {
      runStore: store.runs,
      chatStore: store.chat,
      hitlStore: store.hitl,
      eventBus: new EventBus(),
      remote: store.remote,
      getWorkflow: (id) => (id === remoteWf.id ? remoteWf : getWorkflow(id)),
      runPiFactory: (optsParts) => {
        captured = optsParts as MakeRunPiOpts;
        return stubFactory();
      },
    };
    lifecycle = new RunLifecycle(deps);
    process.env.SECURITY_POSTURE = "dangerous";
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token";
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "r5-")); // stub 写临时目录，不污染 data/
    const reg = new DeviceRegistry();
    const runDeps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback,
      userStore, streamRegistry: new StreamRegistry(), workspaceStore: new WorkspaceStore(db),
      remote: store.remote, deviceRegistry: reg, runLifecycle: lifecycle,
    };
    server = serve(createApp(runDeps), { port: 0, userStore, remote: store.remote, registry: reg });
    member = await userStore.createUser({ username: "m1", password: "password1" });
    store.remote.addGrant(remoteWf.id, member.id);
  });
  afterEach(() => {
    delete process.env.SECURITY_POSTURE;
    delete process.env.AGENTANY_DEV_TOKEN;
    delete process.env.DATA_DIR;
    server.close();
  });

  const mTok = async () => {
    const r = await fetch(server.url("/auth/login"), { method: "POST", headers: JH, body: JSON.stringify({ username: "m1", password: "password1" }) });
    return ((await r.json()) as { token: string }).token;
  };

  test("含 remote 工具 → extensions 叠加 stub 且注入 runBridge", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const conv = store.chat.createConversation({ id: "c1", workspaceId: "ws_company", userId: member.id });
    await lifecycle.start({ workflowId: remoteWf.id, input: {}, conversationId: conv.id });
    expect(captured!.extensions!.length).toBe(1); // 仅 stub（wf.extensions 为空）
    expect(existsSync(captured!.extensions![0])).toBe(true);
    expect(captured!.runBridge).toBeTruthy();
    expect(captured!.runBridge!.runId).toMatch(/^r_/);
    dev.close();
    await dev.waitClose();
  });

  test("非 remote 工作流：无 stub、不注入 runBridge", async () => {
    const tok = await mTok();
    const conv = store.chat.createConversation({ id: "c2", workspaceId: "ws_company", userId: member.id });
    // synthetic-3step 走全局 registry（本测试通过 lifecycle.start 直调，caller 不传 → 无 preflight grant 要求）
    await lifecycle.start({ workflowId: "synthetic-3step", input: {}, conversationId: conv.id });
    expect(captured!.extensions).toEqual([]); // 原样（synthetic extensions:[]）
    expect(captured!.runBridge).toBeUndefined(); // 回归护栏：本地工作流零桥注入
    void tok;
  });
});

describe("R-5 · 转发往返 + 守卫 + 失败语义 + 文件回传", () => {
  let db: ReturnType<typeof openDbMigrated>;
  let store: ReturnType<typeof createStores>;
  let userStore: UserStore;
  let registry: DeviceRegistry;
  let server: ServerHandle;
  let bridge: ReturnType<typeof createBridgeApp>;
  let toolRpc: DeviceToolRpc;
  let member: Awaited<ReturnType<UserStore["createUser"]>>;
  let convId: string;
  let runId: string;

  const newRunNonce = () => issueRunNonce(runId, convId);

  beforeEach(async () => {
    db = openDbMigrated(":memory:");
    store = createStores(db);
    userStore = new UserStore(db);
    registry = new DeviceRegistry();
    toolRpc = new DeviceToolRpc({ registry, timeoutMs: 400 });
    const lifecycleDeps: RunLifecycleDeps = { runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, eventBus: new EventBus(), remote: store.remote, runPiFactory: stubFactory };
    const runLifecycle = new RunLifecycle(lifecycleDeps);
    const deps: RunDeps = {
      runStore: store.runs, chatStore: store.chat, hitlStore: store.hitl, feedbackStore: store.feedback,
      userStore, streamRegistry: new StreamRegistry(), workspaceStore: new WorkspaceStore(db),
      remote: store.remote, deviceRegistry: registry, runLifecycle,
    };
    process.env.SECURITY_POSTURE = "dangerous";
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token";
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "r5-ws-"));
    server = serve(createApp(deps), {
      port: 0, userStore, remote: store.remote, registry,
      onDeviceMessage: (entry, msg) => { toolRpc.route(entry, msg as Record<string, unknown>); },
      onDeviceClose: (entry) => { toolRpc.failAllForUser(entry.userId, `device disconnected (${entry.deviceId})`); },
    });
    bridge = createBridgeApp({
      runLifecycle, runStore: store.runs, chatStore: store.chat, userStore, toolRpc,
    });
    member = await userStore.createUser({ username: "m1", password: "password1" });
    convId = store.chat.createConversation({ id: "c-forward", workspaceId: "ws_company", userId: member.id }).id;
    runId = "r_test_forward";
    store.runs.createRun({ runId, workflowId: remoteWf.id, workspaceId: "ws_company", conversationId: convId, input: {} });
  });
  afterEach(() => {
    delete process.env.SECURITY_POSTURE;
    delete process.env.AGENTANY_DEV_TOKEN;
    delete process.env.DATA_DIR;
    server.close();
  });

  const mTok = async () => {
    const r = await fetch(server.url("/auth/login"), { method: "POST", headers: JH, body: JSON.stringify({ username: "m1", password: "password1" }) });
    return ((await r.json()) as { token: string }).token;
  };
  const invoke = async (opts: { nonce: string; runId?: string; tool?: string; args?: unknown }) =>
    bridge.request("/run/remote-tool", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.nonce}`, ...JH },
      body: JSON.stringify({ runId: opts.runId ?? runId, tool: opts.tool ?? "device_shell", args: opts.args ?? { command: "pwd" } }),
    });

  test("转发往返：设备收 tool_call（tool/args/schema）→ tool_result 回给桥 → pi stub 拿到结构化结果", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const invokeP = invoke({ nonce: newRunNonce() });
    const call = (await dev.waitForMessage("tool_call")) as any;
    expect(call.tool).toBe("device_shell");
    expect(call.args).toEqual({ command: "pwd" });
    expect(typeof call.schema).toBe("object"); // schema 随帧下发（设备侧同名 handler 用）
    expect(call.runId).toBe(runId);
    dev.send({ type: "tool_result", id: call.id, ok: true, stdout: "/home/max" });
    const resp = await invokeP;
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.stdout).toBe("/home/max");
    dev.close();
    await dev.waitClose();
  });

  test("守卫：bad nonce 401 / run 不匹配 403 / 非 remote 工具 400 / 参数不过 400", async () => {
    expect((await invoke({ nonce: "at_bogus" })).status).toBe(401);
    expect((await invoke({ nonce: newRunNonce(), runId: "r_other" })).status).toBe(403);
    expect((await invoke({ nonce: newRunNonce(), tool: "web_search" })).status).toBe(400); // 本地工具不走转发
    expect((await invoke({ nonce: newRunNonce(), args: { command: 42 } })).status).toBe(400); // 参数筛查
  });

  test("失败语义：设备离线 → ok:false device_offline", async () => {
    const resp = await invoke({ nonce: newRunNonce() });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe("device_offline");
  });

  test("失败语义：在飞断连 → 该用户所有在飞调用失败（device_disconnected），不重试", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const invokeP = invoke({ nonce: newRunNonce() });
    await dev.waitForMessage("tool_call"); // 确认已在飞
    dev.close(); // 设备掉线 → onDeviceClose → failAllForUser
    const resp = await invokeP;
    const body = (await resp.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.code).toBe("device_disconnected");
    await dev.waitClose();
  });

  test("失败语义：超时 → ok:false tool_timeout（短超时 RPC，设备不应答）", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const quick = new DeviceToolRpc({ registry, timeoutMs: 80 });
    const invokeP = quick.invoke({ userId: member.id, tool: "device_shell", args: { command: "sleep" }, schema: schema.any(), runId });
    await dev.waitForMessage("tool_call"); // 帧已到但设备不应答
    const r = await invokeP;
    expect(r.ok).toBe(false);
    expect(r.code).toBe("tool_timeout");
    dev.close();
    await dev.waitClose();
  });

  test("文件回传：设备上传落 run 工作区（runs/<runId>/<name> 相对路径）；非所有者 403", async () => {
    const tok = await mTok();
    const fd = new FormData();
    fd.append("runId", runId);
    fd.append("file", new Blob(["report-body"], { type: "text/plain" }), "report.txt");
    const up = await fetch(server.url("/files/device-upload"), { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: fd });
    expect(up.status).toBe(200);
    const body = (await up.json()) as any;
    expect(body.path).toBe(`runs/${runId}/report.txt`);
    // 落盘存在 + 内容对（公司 ws → data/general/workspace）
    const wsRoot = join(process.env.DATA_DIR!, "general", "workspace");
    expect(existsSync(join(wsRoot, body.path))).toBe(true);
    expect(readFileSync(join(wsRoot, body.path), "utf8")).toBe("report-body");
    // 非所有者（他人 token）403
    const other = await userStore.createUser({ username: "eve", password: "password1" });
    const otherTok = await fetch(server.url("/auth/login"), { method: "POST", headers: JH, body: JSON.stringify({ username: "eve", password: "password1" }) });
    const fd2 = new FormData();
    fd2.append("runId", runId);
    fd2.append("file", new Blob(["x"]), "x.txt");
    expect((await fetch(server.url("/files/device-upload"), { method: "POST", headers: { authorization: `Bearer ${((await otherTok.json()) as any).token}` }, body: fd2 })).status).toBe(403);
    void other;
  });
});