// T1（#56）：出站路由胶水——EventBus 帧 → 会话 owner 绑定 → 平台 send（假飞书断言收到）。
// seam：真 store + 真 EventBus + ImOutboundRouter + stub 平台（fake-feishu）；框架 hitl 帧 → 断言目标/文案/uuid。
import { describe, test, expect, beforeEach } from "bun:test";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { UserStore } from "../src/auth/store";
import { EventBus } from "../src/chat/eventbus";
import { ImStore } from "../src/im/store";
import { ImOutboundRouter } from "../src/im/outbound-router";
import { FeishuTransport } from "../src/im/feishu/transport";
import { fakeFeishu, fakeFeishuFetch } from "./fake-feishu";

function setup() {
  const db = openDbMigrated(":memory:");
  const store = new WorkflowStore(db);
  const userStore = new UserStore(db);
  const bus = new EventBus();
  const imStore = new ImStore(db);
  const fake = fakeFeishu();
  const platform = new FeishuTransport({ appId: "cli_x", appSecret: "s_y", baseUrl: "https://fake.feishu", fetchFn: fakeFeishuFetch(fake.app) });
  const router = new ImOutboundRouter({ store, imStore, bus, platform });
  return { store, userStore, imStore, bus, fake, router };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => { ctx = setup(); });

const makeUser = async (u: string) => { await ctx.userStore.createUser({ username: u, password: "pw-long-enough", role: "member" }); return ctx.userStore.getUserByUsername(u)!; };

describe("ImOutboundRouter（出站路由胶水）", () => {
  test("hitl_request 帧 → 会话 owner 的飞书绑定收到渲染文本 + uuid=questionId:type", async () => {
    const m1 = await makeUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.imStore.bind("ou_m1", "feishu", m1.id);
    ctx.router.subscribeAll();
    ctx.bus.publish("c1", { type: "hitl_request", questionId: 7, runId: null, prompt: "选哪个方案？", options: ["A", "B"] });
    await new Promise((r) => setTimeout(r, 10)); // send 异步落 stub
    expect(ctx.fake.state.sent).toHaveLength(1);
    expect(ctx.fake.state.sent[0].receiveId).toBe("ou_m1");
    expect(String((ctx.fake.state.sent[0].content as any).text)).toContain("选哪个方案？");
    expect(ctx.fake.state.sent[0].uuid).toBe("7:hitl_request");
  });

  test("hitl_answered → 确认文本（同路由）；非 hitl 帧（user_message）→ 不产出发送", async () => {
    const m1 = await makeUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.imStore.bind("ou_m1", "feishu", m1.id);
    ctx.router.subscribeAll();
    ctx.bus.publish("c1", { type: "hitl_answered", questionId: 7, answer: { decision: "accept" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(1); // answered → 「已处理」渲染文本
    expect(String((ctx.fake.state.sent[0].content as any).text)).toContain("已处理");
    ctx.bus.publish("c1", { type: "user_message", id: 1, content: "hi" });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(1); // 非 hitl 帧不路由
  });

  test("owner 未绑 feishu（或只绑其它平台）→ 不发送", async () => {
    const m2 = await makeUser("m2");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m2.id }); // 未绑定
    ctx.store.createConversation({ id: "c2", workspaceId: "ws_company", userId: m2.id });
    ctx.imStore.bind("dt_m2", "dingtalk", m2.id); // 只绑钉钉
    ctx.router.subscribeAll();
    ctx.bus.publish("c1", { type: "hitl_request", questionId: 1, runId: null, prompt: "p", options: [] });
    ctx.bus.publish("c2", { type: "hitl_request", questionId: 2, runId: null, prompt: "q", options: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(0);
  });

  test("归档会话不入订阅；subscribeAll 幂等（重复调用不重复投递）", async () => {
    const m1 = await makeUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.store.createConversation({ id: "c2", workspaceId: "ws_company", userId: m1.id });
    ctx.imStore.bind("ou_m1", "feishu", m1.id);
    ctx.store.archiveConversation("c2"); // 归档 → 不订阅
    ctx.router.subscribeAll();
    ctx.router.subscribeAll(); // 幂等
    ctx.bus.publish("c1", { type: "hitl_request", questionId: 3, runId: null, prompt: "p", options: [] });
    ctx.bus.publish("c2", { type: "hitl_request", questionId: 4, runId: null, prompt: "q", options: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(1); // c2 归档不送；c1 只送一次
    expect(ctx.fake.state.sent[0].uuid).toBe("3:hitl_request");
  });

  test("close() 后不再接收（退订清理）", async () => {
    const m1 = await makeUser("m1");
    ctx.store.createConversation({ id: "c1", workspaceId: "ws_company", userId: m1.id });
    ctx.imStore.bind("ou_m1", "feishu", m1.id);
    ctx.router.subscribeAll();
    ctx.router.close();
    ctx.bus.publish("c1", { type: "hitl_request", questionId: 5, runId: null, prompt: "p", options: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.fake.state.sent).toHaveLength(0);
  });
});