// T1（#56）：飞书出站 transport——token 获取+过期缓存、payload 契约、uuid 幂等键透传、卡片优先。
// seam：FeishuTransport 注入 fetchFn → 假飞书（fake-feishu.ts，讲真 HTTP 契约）；无真网络。
import { describe, test, expect } from "bun:test";
import { FeishuTransport } from "../src/im/feishu/transport";
import { fakeFeishu, fakeFeishuFetch } from "./fake-feishu";

const make = () => {
  const fake = fakeFeishu();
  const t = new FeishuTransport({ appId: "cli_x", appSecret: "sec_y", baseUrl: "https://fake.feishu", fetchFn: fakeFeishuFetch(fake.app) });
  return { fake, t };
};

describe("FeishuTransport（出站 send）", () => {
  test("纯文本 send → 假飞书收到 open_id 目标 + 文本 content + Bearer + uuid 透传", async () => {
    const { fake, t } = make();
    await t.send("ou_1001", { text: "提问：选哪？\n选项：\n- A\n- B" }, { uuid: "5:hitl_request" });
    expect(fake.state.sent).toHaveLength(1);
    expect(fake.state.sent[0]).toMatchObject({
      receiveId: "ou_1001",
      msgType: "text",
      content: { text: "提问：选哪？\n选项：\n- A\n- B" },
      uuid: "5:hitl_request",
    });
    expect(fake.state.sent[0].auth).toBe(`Bearer t_fake_1`);
  });

  test("token 一次获取缓存复用（两次 send 只调一次 token 端点）", async () => {
    const { fake, t } = make();
    await t.send("ou_1", { text: "a" });
    await t.send("ou_2", { text: "b" });
    expect(fake.state.tokenCalls).toBe(1); // 缓存
    expect(fake.state.sent).toHaveLength(2);
    expect(fake.state.sent.map((s) => s.auth)).toEqual(["Bearer t_fake_1", "Bearer t_fake_1"]);
  });

  test("cardJson 优先 → msg_type=interactive、content 为卡片原样 JSON", async () => {
    const { fake, t } = make();
    const card = { schema: "2.0", body: { elements: [{ tag: "button" }] } };
    await t.send("ou_1", { cardJson: card });
    expect(fake.state.sent[0]).toMatchObject({ msgType: "interactive", content: card });
  });

  test("无 uuid → 不带 uuid 参数", async () => {
    const { fake, t } = make();
    await t.send("ou_1", { text: "hi" });
    expect(fake.state.sent[0].uuid).toBeNull();
  });

  test("缺凭证 → 构造即拒绝", () => {
    expect(() => new FeishuTransport({ appId: "", appSecret: "" })).toThrow(/appId\/appSecret/);
  });

  test("send 端点返回错误码 → 上抛（不吞失败）", async () => {
    const { fake, t } = make();
    fake.state.failSendWith = { code: 99991662, msg: "params error" };
    await expect(t.send("ou_1", { text: "x" })).rejects.toThrow(/feishu send failed: 99991662 params error/);
  });
});