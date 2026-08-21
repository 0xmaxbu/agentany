// R-3（#75 / ADR-0033）验收：只测外部行为——经 serve() seam（真端口）fetch 驱动：
// 未授权启动 4xx（not_granted）、授权后放行、撤权后 403、停用拦新开、含 remote 工具工作流设备离线 4xx、
// 不含 remote 工作流不受设备影响、admin API（列表含 grantCount/启停增删授权）可观察生效、
// bridge /run/start 同汇一人（nonce→conv→user preflight）。
// 内部实现（preflight 方法体/RunLifecycle 内构）不测。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { createBridgeApp } from "../src/bridge/server";
import { openDbMigrated } from "../src/db/client";
import { createStores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { WorkspaceStore } from "../src/workspaces/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { EventBus } from "../src/chat/eventbus";
import { RunLifecycle } from "../src/runs/lifecycle";
import { serve, type ServerHandle } from "../src/device/server";
import { DeviceRegistry } from "../src/device/registry";
import { FakeDevice } from "./device-ws";
import { getWorkflow } from "../src/registry";
import { defineWorkflow } from "../src/workflow-engine/defineWorkflow";
import { schema } from "../src/workflow-engine/schema";
import { issueNonce } from "../src/bridge/nonce";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const JH = { "content-type": "application/json" };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 测试专用 remote 工作流：声明 tools:["device_shell"]（registry 里 remote:true）→ preflight 设备门触发。
const remoteWf = defineWorkflow({
  id: "remote-device-wf",
  name: "远端测试",
  tools: ["device_shell"],
})
  .step("s1", {
    async execute() {
      return { done: true };
    },
  })
  .commit();

describe("R-3 preflight 授权/启停 + admin 工作流管理（#75）", () => {
  let deps: RunDeps;
  let store: ReturnType<typeof createStores>;
  let userStore: UserStore;
  let registry: DeviceRegistry;
  let server: ServerHandle;
  let admin: Awaited<ReturnType<UserStore["createUser"]>>;
  let member: Awaited<ReturnType<UserStore["createUser"]>>;

  beforeEach(async () => {
    const db = openDbMigrated(":memory:");
    store = createStores(db);
    userStore = new UserStore(db);
    registry = new DeviceRegistry();
    const runLifecycle = new RunLifecycle({
      runStore: store.runs,
      chatStore: store.chat,
      hitlStore: store.hitl,
      eventBus: new EventBus(),
      remote: store.remote,
      runPiFactory: stubFactory,
      getWorkflow: (id) => (id === remoteWf.id ? remoteWf : getWorkflow(id)),
    });
    deps = {
      runStore: store.runs,
      chatStore: store.chat,
      hitlStore: store.hitl,
      feedbackStore: store.feedback,
      userStore,
      streamRegistry: new StreamRegistry(),
      workspaceStore: new WorkspaceStore(db),
      remote: store.remote,
      deviceRegistry: registry,
      runLifecycle,
    };
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token"; // 「auth 强制」态（同 auth.test 惯例）
    process.env.SECURITY_POSTURE = "dangerous"; // fixture 工作流（remote-device-wf）未列 auto 规则——全放，device-online 断言才指到真建 run
    server = serve(createApp(deps), { port: 0, userStore, remote: store.remote, registry });
    admin = await userStore.createUser({ username: "root", password: "password1", role: "admin" });
    member = await userStore.createUser({ username: "m1", password: "password1", role: "member" });
  });

  afterEach(() => {
    delete process.env.AGENTANY_DEV_TOKEN;
    delete process.env.SECURITY_POSTURE;
    server.close();
  });

  const mTok = async () => {
    const r = await fetch(server.url("/auth/login"), { method: "POST", headers: JH, body: JSON.stringify({ username: "m1", password: "password1" }) });
    return ((await r.json()) as { token: string }).token;
  };
  const aTok = async () => {
    const r = await fetch(server.url("/auth/login"), { method: "POST", headers: JH, body: JSON.stringify({ username: "root", password: "password1" }) });
    return ((await r.json()) as { token: string }).token;
  };
  const startSynthetic = async (token: string) => {
    return fetch(server.url("/workflows/synthetic-3step/runs"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...JH },
      body: JSON.stringify({ input: {} }),
    });
  };
  const startRemote = async (token: string) => {
    return fetch(server.url("/workflows/remote-device-wf/runs"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...JH },
      body: JSON.stringify({ input: {} }),
    });
  };

  test("默认锁定：member 无授权启动 → 403 not_granted；admin 放行", async () => {
    const m = await startSynthetic(await mTok());
    expect(m.status).toBe(403);
    expect(((await m.json()) as any).code).toBe("not_granted");
    const a = await startSynthetic(await aTok());
    expect(a.status).toBe(200); // admin 恒授权
  });

  test("授权后放行 → 撤权后 403", async () => {
    const tok = await mTok();
    store.remote.addGrant("synthetic-3step", member.id);
    expect((await startSynthetic(tok)).status).toBe(200);
    store.remote.removeGrant("synthetic-3step", member.id);
    const after = await startSynthetic(tok);
    expect(after.status).toBe(403);
    expect(((await after.json()) as any).code).toBe("not_granted");
  });

  test("停用拦新开（disabled 409）；重新启用恢复", async () => {
    const tok = await mTok();
    store.remote.addGrant("synthetic-3step", member.id);
    store.remote.setEnabled("synthetic-3step", false);
    const dis = await startSynthetic(tok);
    expect(dis.status).toBe(409);
    expect(((await dis.json()) as any).code).toBe("disabled");
    store.remote.setEnabled("synthetic-3step", true);
    expect((await startSynthetic(tok)).status).toBe(200);
  });

  test("含 remote 工具工作流：设备离线 → 409 device_offline；在线 → 放行", async () => {
    const tok = await mTok();
    store.remote.addGrant("remote-device-wf", member.id);
    const off = await startRemote(tok);
    expect(off.status).toBe(409);
    expect(((await off.json()) as any).code).toBe("device_offline");
    // 设备连上 → 放行且真建 run（sync 返回 RunOutcome 带 runId）
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    await delay(20);
    const onlineRes = await startRemote(tok);
    expect(onlineRes.status).toBe(200);
    expect(((await onlineRes.json()) as any).runId).toBeTruthy();
    dev.close();
    await dev.waitClose();
    await delay(20);
    expect((await startRemote(tok)).status).toBe(409); // 断开后又拦
  });

  test("不含 remote 工具工作流不受设备检查影响（回归护栏）", async () => {
    const tok = await mTok();
    store.remote.addGrant("synthetic-3step", member.id);
    // 无任何设备在线
    expect((await startSynthetic(tok)).status).toBe(200);
  });

  test("admin 工作流管理 API：列表/启停/授权增删可观察生效；member 403", async () => {
    const at = await aTok();
    const mt = await mTok();

    // member 无管理权限
    expect((await fetch(server.url("/admin/workflows"), { headers: { authorization: `Bearer ${mt}` } })).status).toBe(403);

    const list = await fetch(server.url("/admin/workflows"), { headers: { authorization: `Bearer ${at}` } });
    const rows = (await list.json()) as any[];
    const syn = rows.find((w) => w.id === "synthetic-3step")!;
    expect(syn.enabled).toBe(true);
    expect(syn.grantCount).toBe(0);

    // 授权（admin 页加）→ member 可跑
    await fetch(server.url("/admin/workflows/synthetic-3step/grants"), {
      method: "POST", headers: { authorization: `Bearer ${at}`, ...JH }, body: JSON.stringify({ userId: member.id }),
    });
    expect((await startSynthetic(await mTok())).status).toBe(200);
    const grants = await fetch(server.url("/admin/workflows/synthetic-3step/grants"), { headers: { authorization: `Bearer ${at}` } });
    expect((await grants.json()) as any[]).toEqual([{ userId: member.id }]);

    // 撤权 → member 又 403
    await fetch(server.url(`/admin/workflows/synthetic-3step/grants/${member.id}`), { method: "DELETE", headers: { authorization: `Bearer ${at}` } });
    expect((await startSynthetic(await mTok())).status).toBe(403);

    // 启停 toggle → 新开被拦
    await fetch(server.url("/admin/workflows/synthetic-3step/config"), {
      method: "POST", headers: { authorization: `Bearer ${at}`, ...JH }, body: JSON.stringify({ enabled: false }),
    });
    const cfgRows = (await (await fetch(server.url("/admin/workflows"), { headers: { authorization: `Bearer ${at}` } })).json()) as any[];
    expect(cfgRows.find((w) => w.id === "synthetic-3step")!.enabled).toBe(false);
  });

  test("bridge /run/start 同一 preflight：member 未授权 → not_granted", async () => {
    const conv = store.chat.createConversation({ id: "c-bridge", workspaceId: "ws_company", userId: member.id });
    const nonce = issueNonce(conv.id);
    const bridge = createBridgeApp({ runLifecycle: deps.runLifecycle, chatStore: store.chat, userStore });
    const r = await bridge.request("/run/start", {
      method: "POST",
      headers: { authorization: `Bearer ${nonce}`, ...JH },
      body: JSON.stringify({ workflowId: "synthetic-3step", input: {} }),
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).code).toBe("not_granted");
  });
});