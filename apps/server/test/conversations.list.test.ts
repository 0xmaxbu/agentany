// GET /conversations 列表（#20/f2）：创建者私有 + workspaceId 过滤 + updatedAt 倒序。
import { describe, test, expect, beforeEach } from "bun:test";
import { createApp } from "../src/app";
import { makeDeps } from "./deps";

const JH = { "content-type": "application/json" };

describe("GET /conversations 列表", () => {
  let app: ReturnType<typeof createApp>;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
    app = createApp(deps); // dev 放行（无 AGENTANY_DEV_TOKEN）——列表按 userId 区分即可
  });

  const mk = (id: string, workspaceId: string, userId: string, title = "") =>
    deps.store.createConversation({ id, workspaceId, userId, title });

  test("只列「我创建的」会话；他人不可见", async () => {
    mk("c1", "ws_company", "alice");
    mk("c2", "ws_company", "bob");
    mk("c3", "ws_acme", "alice");
    const r = await app.request("/conversations", { headers: JH });
    // dev 放行身份 = dev-user：无会话 → 空列表
    expect(((await r.json()) as any[]).length).toBe(0);
  });

  test("按 userId 过滤 + workspaceId 过滤 + 倒序（updatedAt）", async () => {
    // 直接调 store 验证（路由身份经 dev-user，难造多真用户——核心断言在查询语义）
    const a1 = deps.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u1", title: "a" });
    void a1;
    deps.store.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u1", title: "b" });
    deps.store.createConversation({ id: "c3", workspaceId: "ws_acme", userId: "u1", title: "c" });
    deps.store.createConversation({ id: "c4", workspaceId: "ws_company", userId: "u2", title: "d" });

    const mine = deps.store.listConversations("u1");
    expect(mine.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
    const inWs = deps.store.listConversations("u1", "ws_company");
    expect(inWs.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(deps.store.listConversations("u2").map((c) => c.id)).toEqual(["c4"]);
  });

  test("updatedAt 倒序：touch 后排到最前（同秒时间戳也真验证）", () => {
    deps.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u1" });
    deps.store.createConversation({ id: "c2", workspaceId: "ws_company", userId: "u1" });
    // c1 被发消息 → touch → updatedAt 更新 → 排最前（真倒序验证：不依赖两条创建时间戳有差异，
    // 同毫秒并列时顺序未定义，touch 引入确定差异）
    deps.store.touchConversation("c1");
    expect(deps.store.listConversations("u1").map((c) => c.id)).toEqual(["c1", "c2"]);
    // touch 不存在的会话：no-op 不炸
    deps.store.touchConversation("c_nope");
    expect(deps.store.listConversations("u1").map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("HTTP 层：dev-user 自建会话可见", async () => {
    await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) });
    const r = await app.request("/conversations", { headers: JH });
    const list = (await r.json()) as any[];
    expect(list.length).toBe(1);
    expect(list[0].userId).toBe("dev-user");
    expect(list[0].workspaceId).toBe("ws_company");
    // ws 过滤参数
    const none = await app.request("/conversations?workspaceId=ws_nope", { headers: JH });
    expect(((await none.json()) as any[]).length).toBe(0);
  });
});
