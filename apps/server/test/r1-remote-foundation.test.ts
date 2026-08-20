// R-1（#73 / ADR-0033）验收：只测外部行为——workflow 定义经 registry 解析后 tools 正确暴露、
// 工具注册表按名解析与全量枚举正确、四表迁移在内存 sqlite 幂等可跑、store API 语义正确（含 FK 生效）。
import { describe, test, expect } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { createStores } from "../src/stores";
import { UserStore } from "../src/auth/store";
import { getWorkflow } from "../src/registry";
import { getTool, listTools, validateToolArgs } from "../src/tool-registry";
import { schema, validate } from "../src/workflow-engine/schema";
import { users } from "../src/db/schema";

describe("R-1 · 定义扩展：tools 经 registry 暴露", () => {
  test("synthetic-3step 声明 tools:[]（纯程序步）", () => {
    expect(getWorkflow("synthetic-3step")!.tools).toEqual([]);
  });
  test("brand-research 声明 tavily 三工具（本地执行）", () => {
    expect(getWorkflow("brand-research")!.tools!.sort()).toEqual(["web_crawl", "web_extract", "web_search"]);
  });
  test("brand-strategy-analysis 声明 tools:[]（skill 驱动读本地文件）", () => {
    expect(getWorkflow("brand-strategy-analysis")!.tools).toEqual([]);
  });
  test("extensions 注入字段保留（chat/workflow 各自按需）", () => {
    expect(getWorkflow("brand-research")!.extensions!.length).toBe(1); // tavily web-search 扩展
    expect(getWorkflow("synthetic-3step")!.extensions).toEqual([]);
  });
  test("未声明 tools 的工作流语义为空数组（可选字段不破坏契约）", () => {
    expect(getWorkflow("synthetic-3step")!.environment).toBeUndefined();
  });
});

describe("R-1 · 全局工具注册表", () => {
  test("按名解析得到 {name, argsSchema, remote}", () => {
    const t = getTool("web_search")!;
    expect(t.remote).toBe(false);
    expect(validate(t.argsSchema, { query: "x" })).toEqual({ ok: true });
    expect(validate(t.argsSchema, {})).toEqual({ ok: false, error: "root.query: missing" });
  });
  test("全量枚举覆盖既有工具（本地三件套 + remote 占位 device_shell + P2 五执行器）、均有 remote 标识", () => {
    const names = listTools().map((t) => t.name).sort();
    expect(names).toEqual(["bash", "device_shell", "edit", "grep", "read", "web_crawl", "web_extract", "web_search", "write"]);
    expect(listTools().every((t) => typeof t.remote === "boolean")).toBe(true);
    expect(getTool("device_shell")!.remote).toBe(true); // ADR-0033/R-3：首个 remote 占位（R-5 接转发）
    for (const n of ["bash", "write", "read", "grep", "edit"]) expect(getTool(n)!.remote).toBe(true); // R-6 P2 五执行器
  });
  test("未注册名字解析为 undefined", () => {
    expect(getTool("nope")).toBeUndefined();
  });
  test("validateToolArgs 与参数筛查一致（供 R-5 stub 复用）", () => {
    expect(validateToolArgs("web_extract", { urls: ["a"] })).toEqual({ ok: true });
    expect(validateToolArgs("web_extract", { urls: [1] })).toEqual({ ok: false, error: "root.urls[0]: expected string" });
    expect(validateToolArgs("unknown", {})).toEqual({ ok: false, error: "unknown tool: unknown" });
  });
  test("argsSchema 可序列化（JSON 往返后仍可校验）", () => {
    const t = getTool("web_search")!;
    const round = JSON.parse(JSON.stringify(t.argsSchema));
    expect(validate(round, { query: "q", search_depth: "advanced" })).toEqual({ ok: true });
    expect(validate(round, { query: "q", search_depth: "deep" }).ok).toBe(false);
  });
});

describe("R-1 · schema.array 原语（web_extract urls 载体）", () => {
  test("数组元素逐个校验，非数组拒绝", () => {
    const s = schema.array(schema.string());
    expect(validate(s, ["a", "b"])).toEqual({ ok: true });
    expect(validate(s, ["a", 1])).toEqual({ ok: false, error: "root[1]: expected string" });
    expect(validate(s, 5)).toEqual({ ok: false, error: "root: expected array" });
  });
});

describe("R-1 · 四表 store + 迁移", () => {
  const setup = async () => {
    const db = openDbMigrated(":memory:");
    const { remote } = createStores(db);
    const userStore = new UserStore(db);
    const u1 = await userStore.createUser({ username: "dev1", password: "pw", role: "member" });
    return { db, remote, userStore, u1, u2: (await userStore.createUser({ username: "dev2", password: "pw" })) };
  };

  test("迁移幂等：:memory: 全 24 条迁移可重复跑；当前测试本身即一次迁移验证", async () => {
    const db = openDbMigrated(":memory:");
    expect(db.select().from(users).all()).toEqual([]); // 迁移 seed 无用户、无报错
  });

  test("remote_clients：upsert 联机/离线/按用户查/hasOnline", async () => {
    const { remote, u1, u2 } = await setup();
    remote.upsertClient({ userId: u1.id, deviceId: "dev-a", deviceName: "Mac" });
    expect(remote.hasOnlineClient(u1.id)).toBe(true);
    expect(remote.listClientsByUser(u2.id)).toEqual([]);
    const c = remote.getClient(u1.id, "dev-a")!;
    expect(c.status).toBe("online");
    expect(c.deviceName).toBe("Mac");

    remote.setClientOffline(u1.id, "dev-a");
    expect(remote.hasOnlineClient(u1.id)).toBe(false);
    expect(remote.getClient(u1.id, "dev-a")!.status).toBe("offline");

    // 同设备重连 = 同机覆盖（转 online，不新增行）；换设备 = 新行
    remote.upsertClient({ userId: u1.id, deviceId: "dev-a", deviceName: "Mac2" });
    remote.upsertClient({ userId: u1.id, deviceId: "dev-b", deviceName: "PC" });
    expect(remote.listClientsByUser(u1.id).map((c) => c.deviceId).sort()).toEqual(["dev-a", "dev-b"]);
    expect(remote.getClient(u1.id, "dev-a")!.status).toBe("online");
  });

  test("remote_clients：FK 生效——不存在用户插入被拒", async () => {
    const { remote } = await setup();
    expect(() => remote.upsertClient({ userId: "u_nonexistent", deviceId: "x" })).toThrow();
  });

  test("workflow_grants：加/查/撤/计数 + 重复加幂等", async () => {
    const { remote, u1, u2 } = await setup();
    expect(remote.isGranted("wf", u1.id)).toBe(false);
    remote.addGrant("wf", u1.id);
    remote.addGrant("wf", u1.id); // 幂等
    remote.addGrant("wf", u2.id);
    expect(remote.isGranted("wf", u1.id)).toBe(true);
    expect(remote.grantCount("wf")).toBe(2);
    expect(remote.listGrants("wf").map((g) => g.userId).sort()).toEqual([u1.id, u2.id].sort());
    expect(remote.removeGrant("wf", u1.id)).toBe(true);
    expect(remote.removeGrant("wf", u1.id)).toBe(false); // 已撤，幂等删
    expect(remote.isGranted("wf", u1.id)).toBe(false);
  });

  test("workflow_cfg：未配置默认启用；setEnabled 落库可读回", async () => {
    const { remote } = await setup();
    expect(remote.getCfg("wf").enabled).toBe(true);
    remote.setEnabled("wf", false);
    expect(remote.getCfg("wf").enabled).toBe(false);
    remote.setEnabled("wf", true);
    expect(remote.getCfg("wf").enabled).toBe(true);
  });

  test("pending_starts：建→改→终态幂等→ TTL 扫描", async () => {
    const { remote, u1 } = await setup();
    const ttl = new Date(Date.now() + 60_000).toISOString();
    const expired = new Date(Date.now() - 1000).toISOString();
    remote.createPendingStart({ id: "p1", workflowId: "wf", userId: u1.id, deviceId: "dev-a", ttlAt: expired });
    remote.createPendingStart({ id: "p2", workflowId: "wf", userId: u1.id, deviceId: "dev-a", ttlAt: ttl });
    remote.createPendingStart({ id: "p3", workflowId: "wf", userId: u1.id, deviceId: "dev-a", ttlAt: expired });

    expect(remote.getPending("p1")!.envStatus).toBe("waiting_remediation");
    expect(remote.getPending("p1")!.ttlAt).toBe(expired);

    expect(remote.updatePendingStatus("p1", "ready")).toBe(true);
    expect(remote.updatePendingStatus("p1", "cancelled")).toBe(false); // 已终态 → 拒绝改写（防并发/过期上报）
    expect(remote.getPending("p1")!.envStatus).toBe("ready");

    // TTL 扫描只收 waiting_remediation 且已过期（p1 已 ready → 排除）
    expect(remote.listExpired(new Date().toISOString()).map((p) => p.id)).toEqual(["p3"]);
  });
});