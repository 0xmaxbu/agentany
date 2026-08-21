// R-2（#74 / ADR-0033）验收：只测外部行为——经 `serve()`（单 seam，真端口）起活后，fetch 打
// device-login、假设备 WS 客户端连 /ws/device：登录成功/坏密码 401、无 token 连不上、单机顶号
// （旧连接被服务端 close）、同设备重连覆盖、重连重验、logout 撤销+离线、remote_clients 状态翻转、
// dev 阀不覆盖设备路径、心跳 ping/pong。内部实现（registry 结构）不测。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { createStores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { WorkspaceStore } from "../src/workspaces/store";
import { StreamRegistry } from "../src/chat/stream-registry";
import { serve, type ServerHandle } from "../src/device/server";
import { DeviceRegistry, KICK_REASON, RECONNECT_REASON, LOGOUT_REASON } from "../src/device/registry";
import { FakeDevice } from "./device-ws";
import type { RunDeps } from "../src/runs";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("R-2 设备入网与单机登录（#74）", () => {
  let deps: RunDeps;
  let store: ReturnType<typeof createStores>;
  let userStore: UserStore;
  let registry: DeviceRegistry;
  let server: ServerHandle;
  let sharedUser: Awaited<ReturnType<UserStore["createUser"]>>;

  beforeEach(async () => {
    const db = openDbMigrated(":memory:");
    store = createStores(db);
    userStore = new UserStore(db);
    registry = new DeviceRegistry();
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
    };
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token"; // 「auth 强制」态（=prod）：吊销 → 401（auth.test.ts 惯例）
    server = serve(createApp(deps), { port: 0, userStore, remote: store.remote, registry });
    sharedUser = await userStore.createUser({ username: "alice", password: "password1", role: "member" });
  });

  afterEach(() => {
    delete process.env.AGENTANY_DEV_TOKEN; // 防泄漏（其它测试文件依赖 pass-through）
    server.close();
  });

  const login = async (u = sharedUser.username, pw = "password1", deviceId = "dev-a", deviceName?: string) => {
    const r = await fetch(server.url("/auth/device-login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: u, password: pw, deviceId, deviceName }),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const connect = (token: string, deviceId: string) =>
    FakeDevice.connect(server.wsUrl("/ws/device"), { token, deviceId });

  test("device-login 成功返 token+user（无 hash），remote_clients 联机", async () => {
    const { status, body } = await login("alice", "password1", "dev-a", "MacBook");
    expect(status).toBe(200);
    expect(typeof body.token).toBe("string");
    expect(body.user.username).toBe("alice");
    expect(body.user).not.toHaveProperty("passwordHash");
    const c = store.remote.getClient(sharedUser.id, "dev-a")!;
    expect(c.status).toBe("online");
    expect(c.deviceName).toBe("MacBook");
  });

  test("坏密码 / 不存在用户 / 坏 deviceId → 401/400", async () => {
    expect((await login("alice", "wrongpass")).status).toBe(401);
    expect((await login("nobody", "whatever1")).status).toBe(401);
    expect((await login("alice", "password1", "bad id!")).status).toBe(400);
  });

  test("无 token / 坏 token：/ws/device 升级被拒，不建立连接", async () => {
    await expect(connect("", "dev-a")).rejects.toThrow();
    await expect(connect("at_bogus", "dev-a")).rejects.toThrow();
  });

  test("连上后 remote_clients status=online；设备主动关闭 → offline", async () => {
    const l = await login("alice", "password1", "dev-a");
    const dev = await connect(l.body.token, "dev-a");
    await delay(20);
    expect(store.remote.getClient(sharedUser.id, "dev-a")!.status).toBe("online");
    dev.close();
    await dev.waitClose();
    await delay(20);
    expect(store.remote.getClient(sharedUser.id, "dev-a")!.status).toBe("offline");
  });

  test("单机顶号：同用户换设备连接 → 旧连接被服务端 close（kicked_by_another_device）", async () => {
    const a = await login("alice", "password1", "dev-a");
    const devA = await connect(a.body.token, "dev-a");
    const b = await login("alice", "password1", "dev-b");
    const devB = await connect(b.body.token, "dev-b");
    const closed = await devA.waitClose();
    expect(closed.code).toBe(4000);
    expect(closed.reason).toBe(KICK_REASON);
    expect(devB.messages().length).toBe(0); // 新设备未受影响
    expect(store.remote.getClient(sharedUser.id, "dev-a")!.status).toBe("offline"); // 被顶号 → 离线
  });

  test("同设备重连 → 覆盖自身旧连接（reconnected），不对别机顶号", async () => {
    const l = await login("alice", "password1", "dev-a");
    const a1 = await connect(l.body.token, "dev-a");
    const a2 = await connect(l.body.token, "dev-a");
    const closed = await a1.waitClose();
    expect(closed.reason).toBe(RECONNECT_REASON);
    // 换机再顶号仍成立（重连后顶号语义不受影响）
    const b = await login("alice", "password1", "dev-b");
    const devB = await connect(b.body.token, "dev-b");
    expect((await a2.waitClose()).reason).toBe(KICK_REASON);
    expect(devB.messages().length).toBe(0);
  });

  test("重连重验：logout 后旧 token 连不上", async () => {
    const l = await login("alice", "password1", "dev-a");
    await connect(l.body.token, "dev-a");
    const out = await fetch(server.url("/auth/device-logout"), { method: "POST", headers: { authorization: `Bearer ${l.body.token}` } });
    expect(out.status).toBe(200);
    await expect(connect(l.body.token, "dev-a")).rejects.toThrow(); // token 已吊销，重连重验被拒
  });

  test("device-logout：token 撤销 + 设备 offline + WS 关闭（logout reason）", async () => {
    const l = await login("alice", "password1", "dev-a");
    const dev = await connect(l.body.token, "dev-a");
    const out = await fetch(server.url("/auth/device-logout"), { method: "POST", headers: { authorization: `Bearer ${l.body.token}` } });
    expect(out.status).toBe(200);
    const closed = await dev.waitClose();
    expect(closed.reason).toBe(LOGOUT_REASON);
    await delay(20);
    expect(store.remote.getClient(sharedUser.id, "dev-a")!.status).toBe("offline");
    // 旧 token 复用被拒（auth 强制态）
    const me = await fetch(server.url("/me"), { headers: { authorization: `Bearer ${l.body.token}` } });
    expect(me.status).toBe(401);
  });

  test("dev 阀边界：AGENTANY_DEV_TOKEN 已设，坏 token 仍连不上（设备路径不走 dev 阀）", async () => {
    process.env.AGENTANY_DEV_TOKEN = "dev-test-token"; // 已在 beforeEach
    await expect(connect("at_wrong", "dev-a")).rejects.toThrow(); // resolveToken null → 401，不落 dev 逃生阀
  });

  test("心跳：设备 ping → 服务器 pong", async () => {
    const l = await login("alice", "password1", "dev-a");
    const dev = await connect(l.body.token, "dev-a");
    dev.send({ type: "ping" });
    const pong = (await dev.waitForMessage("pong")) as any;
    expect(pong.type).toBe("pong");
  });
});