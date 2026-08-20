// R-4（#76 / ADR-0033）验收：只测外部行为——serve() + scripted 假设备 WS 客户端驱动：
// env pass 直跑 / fail_hard 拒启动含表格 / fail_installable → pending + 确定性 pendingStartId、
// 设备 approved 后自动复检并自动开 run / declined → cancelled / TTL 过期 → failed /
// 来源设备不匹配与终态重放被幂等忽略。/ 无 environment 的 remote 工作流不触发环境检测（回归护栏）。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { WorkspaceStore } from "../src/workspaces/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { EventBus } from "../src/chat/eventbus";
import { RunLifecycle, type RunLifecycleDeps } from "../src/runs/lifecycle";
import { serve, type ServerHandle } from "../src/device/server";
import { DeviceRegistry } from "../src/device/registry";
import { DeviceEnvRpc } from "../src/device/env";
import { FakeDevice } from "./device-ws";
import { getWorkflow } from "../src/registry";
import { defineWorkflow } from "../src/workflow-engine/defineWorkflow";
import { workflowRuns } from "../src/db/schema";
import { eq } from "drizzle-orm";
import type { RunDeps } from "../src/runs";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";
import type { EnvCheckItem } from "../src/device/env";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const JH = { "content-type": "application/json" };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, t = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < t) {
    if (pred()) return;
    await delay(10);
  }
  throw new Error("delayUntil timeout");
};

const ENV_TABLE = {
  pass: (): EnvCheckItem[] => [
    { id: "gpu", name: "NVIDIA GPU", ok: true, autoInstallable: false },
    { id: "ffmpeg", name: "ffmpeg", ok: true, autoInstallable: true },
  ],
  hardFail: (): EnvCheckItem[] => [
    { id: "gpu", name: "NVIDIA GPU", ok: false, reason: "缺显卡驱动", autoInstallable: false },
    { id: "ffmpeg", name: "ffmpeg", ok: true, autoInstallable: true },
  ],
  installable: (): EnvCheckItem[] => [
    { id: "gpu", name: "NVIDIA GPU", ok: true, autoInstallable: false },
    { id: "ffmpeg", name: "ffmpeg", ok: false, reason: "未安装", autoInstallable: true },
  ],
} as const;

// 测试专用 remote 工作流：环境要求（gpu 硬失败 / ffmpeg 可自动补装）。
const remoteWf = defineWorkflow({
  id: "remote-device-wf",
  name: "远端测试",
  tools: ["device_shell"],
  environment: [
    { id: "gpu", name: "NVIDIA GPU", check: "nvidia-smi", autoInstall: null },
    { id: "ffmpeg", name: "ffmpeg", check: "ffmpeg -version", autoInstall: "brew install ffmpeg" },
  ],
})
  .step("s1", {
    async execute() {
      return { done: true };
    },
  })
  .commit();

// 反向护栏 fixture：remote 但无 environment 声明 → 不触发环境检测。
const noEnvWf = defineWorkflow({ id: "remote-no-env", tools: ["device_shell"] })
  .step("s1", {
    async execute() {
      return { ok: true };
    },
  })
  .commit();

/** 等 check_environment 并用指定表格回 env_report。 */
async function answerEnvCheck(dev: FakeDevice, table: EnvCheckItem[], statusHint?: string) {
  const m = (await dev.waitForMessage("check_environment")) as any;
  dev.send({ type: "env_report", id: m.id, result: { status: statusHint, table } });
  return m;
}

describe("R-4 环境检测与挂起-自动续（#76）", () => {
  let db: ReturnType<typeof openDbMigrated>;
  let store: ReturnType<typeof createStores>;
  let userStore: UserStore;
  let registry: DeviceRegistry;
  let server: ServerHandle;
  let envRpc: DeviceEnvRpc;
  let runLifecycle: RunLifecycle;
  let deps: RunDeps;
  let member: Awaited<ReturnType<UserStore["createUser"]>>;
  let member2: Awaited<ReturnType<UserStore["createUser"]>>;

  beforeEach(async () => {
    db = openDbMigrated(":memory:");
    store = createStores(db);
    userStore = new UserStore(db);
    registry = new DeviceRegistry();
    const lifecycleDeps: RunLifecycleDeps = {
      runStore: store.runs,
      chatStore: store.chat,
      hitlStore: store.hitl,
      eventBus: new EventBus(),
      remote: store.remote,
      runPiFactory: stubFactory,
      getWorkflow: (id) => (id === remoteWf.id ? remoteWf : id === noEnvWf.id ? noEnvWf : getWorkflow(id)),
    };
    runLifecycle = new RunLifecycle(lifecycleDeps);
    envRpc = new DeviceEnvRpc({
      registry,
      remote: store.remote,
      getWorkflow: lifecycleDeps.getWorkflow,
      onReady: (p) => {
        let input: unknown = {};
        try { input = p.input ? JSON.parse(p.input) : {}; } catch { /* 兜底 */ }
        void runLifecycle.start({
          workflowId: p.workflowId,
          input,
          workspaceId: p.workspaceId ?? undefined,
          conversationId: p.conversationId ?? undefined,
          caller: { id: p.userId, role: "member" },
          skipEnvCheck: true,
        });
      },
    });
    lifecycleDeps.deviceRpc = envRpc; // 晚绑定
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
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token";
    process.env.SECURITY_POSTURE = "dangerous"; // fixture 工作流未列 auto 规则（fail-closed deny 会挡 fixture）——全放无审批
    server = serve(createApp(deps), {
      port: 0,
      userStore,
      remote: store.remote,
      registry,
      onDeviceMessage: (entry, msg) => void envRpc.route(entry, msg as Record<string, unknown>),
    });
    member = await userStore.createUser({ username: "m1", password: "password1" });
    member2 = await userStore.createUser({ username: "m2", password: "password1" });
    store.remote.addGrant(remoteWf.id, member.id);
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
  const startRemote = async (token: string) =>
    fetch(server.url("/workflows/remote-device-wf/runs"), { method: "POST", headers: { authorization: `Bearer ${token}`, ...JH }, body: JSON.stringify({ input: {} }) });
  const runsOf = () =>
    db.select({ runId: workflowRuns.runId }).from(workflowRuns).where(eq(workflowRuns.workflowId, remoteWf.id)).all();

  test("env pass → 直跑建 run（无挂起）", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const startP = startRemote(tok);
    await answerEnvCheck(dev, ENV_TABLE.pass());
    const res = await startP;
    expect(res.status).toBe(200);
    await delayUntil(() => runsOf().length === 1);
    dev.close();
  });

  test("fail_hard → 拒启动（409 env_fail + 缺失表格）且不建 run", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const startP = startRemote(tok);
    await answerEnvCheck(dev, ENV_TABLE.hardFail(), "fail_hard");
    const res = await startP;
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("env_fail");
    expect(body.detail.table).toHaveLength(2);
    expect((body.detail.table as EnvCheckItem[])[0].ok).toBe(false);
    await delay(30);
    expect(runsOf()).toHaveLength(0);
    dev.close();
    await dev.waitClose();
  });

  test("fail_installable → 409 env_installable_pending + pendingStartId；pending 落 waiting_remediation；不建 run", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const startP = startRemote(tok);
    await answerEnvCheck(dev, ENV_TABLE.installable(), "fail_installable");
    const res = await startP;
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("env_installable_pending");
    const pendingId = (body.detail as any).pendingStartId as string;
    const p = store.remote.getPending(pendingId)!;
    expect(p.envStatus).toBe("waiting_remediation");
    expect(p.deviceId).toBe("dev1");
    await delay(30);
    expect(runsOf()).toHaveLength(0);
    dev.close();
    await dev.waitClose();
  });

  test("approved → 服务端自动复检 → pass → 自动开 run（挂起-自动续闭环）", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const startP = startRemote(tok);
    await answerEnvCheck(dev, ENV_TABLE.installable(), "fail_installable");
    const res = await startP;
    const pendingId = ((await res.json()) as any).detail.pendingStartId;

    // 设备用户同意 → env_remediated → 服务器重发 check_environment（自动复检）→ pass → run 自动创建
    dev.send({ type: "env_remediated", pendingStartId: pendingId, approved: true });
    await answerEnvCheck(dev, ENV_TABLE.pass()); // 复检（第二次 check_environment）
    await delayUntil(() => runsOf().length === 1);
    expect(store.remote.getPending(pendingId)!.envStatus).toBe("ready");
    dev.close();
    await dev.waitClose();
  });

  test("declined → pending cancelled、服务端不再复检、不建 run", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const startP = startRemote(tok);
    await answerEnvCheck(dev, ENV_TABLE.installable(), "fail_installable");
    const res = await startP;
    const pendingId = ((await res.json()) as any).detail.pendingStartId;

    dev.send({ type: "env_remediated", pendingStartId: pendingId, approved: false });
    await delayUntil(() => store.remote.getPending(pendingId)!.envStatus === "cancelled");
    expect(runsOf()).toHaveLength(0);
    // 无复检帧（clean）：清队列后极短超时验证不会来
    dev.clear();
    await expect(dev.waitForMessage("check_environment", 150)).rejects.toThrow();
    dev.close();
    await dev.waitClose();
  });

  test("来源设备不匹配 / 终态重放 → 幂等忽略", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const startP = startRemote(tok);
    await answerEnvCheck(dev, ENV_TABLE.installable(), "fail_installable");
    const res = await startP;
    const pendingId = ((await res.json()) as any).detail.pendingStartId;

    // 别人（member2）的设备的 approved 上报被忽略
    const tok2 = await fetch(server.url("/auth/login"), { method: "POST", headers: JH, body: JSON.stringify({ username: "m2", password: "password1" }) });
    const dev2 = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: ((await tok2.json()) as any).token, deviceId: "dev2" });
    dev2.send({ type: "env_remediated", pendingStartId: pendingId, approved: true });
    await delay(50);
    expect(store.remote.getPending(pendingId)!.envStatus).toBe("waiting_remediation"); // 未采纳

    // 正确设备同意 → cancelled（终态）→ 重放 approved 被幂等忽略（不再复检）
    dev.send({ type: "env_remediated", pendingStartId: pendingId, approved: false });
    await delayUntil(() => store.remote.getPending(pendingId)!.envStatus === "cancelled");
    dev.send({ type: "env_remediated", pendingStartId: pendingId, approved: true });
    await delay(50);
    expect(store.remote.getPending(pendingId)!.envStatus).toBe("cancelled");
    expect(runsOf()).toHaveLength(0);
    dev.close();
    await dev.waitClose();
    dev2.close();
    await dev2.waitClose();
  });

  test("TTL 过期：设备后知同意 → pending failed（惰性 TTL 兜底）", async () => {
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    // 手工建已过期 pending（模拟 waiting 超时）
    const id = "p_test_ttl";
    store.remote.createPendingStart({
      id, workflowId: remoteWf.id, userId: member.id, deviceId: "dev1",
      ttlAt: new Date(Date.now() - 1000).toISOString(), input: "{}",
    });
    dev.send({ type: "env_remediated", pendingStartId: id, approved: true });
    await delayUntil(() => store.remote.getPending(id)!.envStatus === "failed");
    expect(store.remote.getPending(id)!.reason).toBe("ttl_expired");
    expect(runsOf()).toHaveLength(0);
    dev.close();
    await dev.waitClose();
  });

  test("无 environment 声明的 remote 工作流不触发环境检测（回归护栏）", async () => {
    store.remote.addGrant("remote-no-env", member.id);
    const tok = await mTok();
    const dev = await FakeDevice.connect(server.wsUrl("/ws/device"), { token: tok, deviceId: "dev1" });
    const r = await fetch(server.url("/workflows/remote-no-env/runs"), { method: "POST", headers: { authorization: `Bearer ${tok}`, ...JH }, body: JSON.stringify({ input: {} }) });
    expect(r.status).toBe(200);
    dev.clear();
    await expect(dev.waitForMessage("check_environment", 150)).rejects.toThrow(); // 不应发 env 检测帧
    dev.close();
    await dev.waitClose();
  });
});