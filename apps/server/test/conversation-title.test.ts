// 会话自动命名（#命名）：首轮 turn 完成 → title=null 时起一次性 LLM 调用提取主题 →
// 落库（只改 title 不动 updatedAt）+ emit title 帧（前端实时换名）。幂等：已有 title 不再触发。
// DI：复用 runPiStreamFactory stub——命名调用与聊天 turn 走同一 factory（prompt 含「标题」指令特征可断言）。
import { describe, test, expect } from "bun:test";
import { createApp } from "../src/app";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { fullDeps } from "./deps";
import type { ConfiguredRunPiStream } from "../src/pi/runPi-factory";

const JH = { "content-type": "application/json" };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await delay(15);
  }
};

const emitText = (call: { onBlock?: (b: import("../src/blocks").StreamBlock) => void }, text: string) => {
  const emit = call.onBlock ?? (() => {});
  emit({ op: "start", blockId: `b_${text.length}`, kind: "text" });
  emit({ op: "delta", blockId: `b_${text.length}`, delta: text });
  emit({ op: "end", blockId: `b_${text.length}` });
};

/** 可编程 factory：默认回复 echo；命名调用（prompt 含 TITLE_MARK）回 LLM_TITLE。 */
const LLM_TITLE = "帮我给品牌起名字的建议"; // 10 字 ≥ TITLE_MIN
const TITLE_MARK = "提取主题";
function namingFactory() {
  const prompts: string[] = [];
  const factory = () =>
    (async (call) => {
      prompts.push(call.prompt);
      if (call.prompt.includes(TITLE_MARK)) {
        emitText(call, LLM_TITLE);
        return { text: LLM_TITLE, messages: [], toolResults: [] };
      }
      emitText(call, `echo:${call.prompt}`);
      return { text: `echo:${call.prompt}`, messages: [], toolResults: [] };
    }) as ConfiguredRunPiStream;
  return { factory, prompts: () => prompts };
}

async function openStream(app: ReturnType<typeof createApp>, convId: string) {
  const resp = await app.request(`/conversations/${convId}/stream`);
  const reader = resp.body!.getReader();
  const frames: any[] = [];
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value!, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            try { frames.push(JSON.parse(line.slice(6))); } catch { /* 非 JSON */ }
          }
        }
      }
    }
  })().catch(() => {});
  return { frames, reader };
}

function newApp(factory: () => ConfiguredRunPiStream) {
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  const deps = fullDeps(store, { runPiStreamFactory: factory });
  return { app: createApp(deps), store };
}

const postMsg = (app: ReturnType<typeof createApp>, id: string, content: string) =>
  app.request(`/conversations/${id}/messages`, { method: "POST", headers: JH, body: JSON.stringify({ content }) });

describe("会话自动命名（#命名）", () => {
  test("首轮 turn 完成 → LLM 提取主题 → title 落库（updatedAt 不变）+ title 帧", async () => {
    const n = namingFactory();
    const { app, store } = newApp(n.factory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    expect(c.title).toBeNull();

    const s = await openStream(app, c.id);
    await delay(15);
    const r = await postMsg(app, c.id, "帮我想几个品牌名");
    expect(r.status).toBe(202);
    await delayUntil(() => s.frames.some((f) => f.type === "title"));

    // 命名调用真的发生（prompt 含指令 + 原文素材）
    expect(n.prompts().some((p) => p.includes(TITLE_MARK) && p.includes("帮我想几个品牌名"))).toBe(true);
    // title 落库且 = LLM 输出
    const conv = store.getConversation(c.id)!;
    expect(conv.title).toBe(LLM_TITLE);
    // updatedAt 不被重命名改写（排序锚只属于 touch——POST 消息 touch 过一次，命名须在其之前或相等）
    expect(conv.updatedAt <= (store.getConversation(c.id)!.updatedAt)).toBe(true);
    // title 帧在流上（前端实时换名）——delayUntil 只保证落库，帧读取异步再等一拍
    await delayUntil(() => s.frames.some((f) => f.type === "title"), 1000);
    expect(s.frames.filter((f) => f.type === "title")).toEqual([{ type: "title", title: LLM_TITLE }]);
    await s.reader.cancel();
  });

  test("已有 title（建会话时显式给）→ 不触发命名调用", async () => {
    const n = namingFactory();
    const { app } = newApp(n.factory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({ title: "固定名" }) })).json();
    const s = await openStream(app, c.id);
    await delay(15);
    await postMsg(app, c.id, "你好");
    await delayUntil(() => s.frames.some((f) => f.type === "done"));
    await delay(100); // 命名若误触发也该已入 prompts
    expect(n.prompts().some((p) => p.includes(TITLE_MARK))).toBe(false);
    await s.reader.cancel();
  });

  test("素材不足（累计 user 消息 <8 字）→ 本轮跳过不命名；第二轮素材够了才命名", async () => {
    const n = namingFactory();
    const { app, store } = newApp(n.factory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    const s = await openStream(app, c.id);
    await delay(15);

    // 第一轮：仅「你好」（2 字 <8）→ 不起命名调用，title 保持 null（显示「新会话」）
    await postMsg(app, c.id, "你好");
    await delayUntil(() => s.frames.some((f) => f.type === "done"));
    await delay(100);
    expect(store.getConversation(c.id)!.title).toBeNull();
    expect(n.prompts().some((p) => p.includes(TITLE_MARK))).toBe(false);

    // 第二轮：补充实质内容（累计 ≥8 字）→ 命名触发，素材含两轮消息
    await postMsg(app, c.id, "帮我想几个品牌名，要中文的");
    await delayUntil(() => s.frames.some((f) => f.type === "title"));
    const namingPrompt = n.prompts().find((p) => p.includes(TITLE_MARK))!;
    expect(namingPrompt).toContain("你好"); // 素材 = 累计 user 消息（非仅本轮）
    expect(namingPrompt).toContain("帮我想几个品牌名");
    expect(store.getConversation(c.id)!.title).toBe(LLM_TITLE);
    await s.reader.cancel();
  });

  test("LLM 输出短于下限（<8 字）→ 跳过不落库（下轮再试），不硬造名字", async () => {
    const factory = () =>
      (async (call) => {
        if (call.prompt.includes(TITLE_MARK)) {
          emitText(call, "品牌"); // 2 字——违反下限
          return { text: "品牌", messages: [], toolResults: [] };
        }
        emitText(call, "ok");
        return { text: "ok", messages: [], toolResults: [] };
      }) as ConfiguredRunPiStream;
    const { app, store } = newApp(factory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    const s = await openStream(app, c.id);
    await delay(15);
    await postMsg(app, c.id, "帮我想几个品牌名，要中文的");
    await delayUntil(() => s.frames.some((f) => f.type === "done"));
    await delay(100); // 命名若落库也该已完成
    expect(store.getConversation(c.id)!.title).toBeNull(); // 不命名 = 保持「新会话」
    expect(s.frames.some((f: any) => f.type === "title")).toBe(false); // 也不发帧
    await s.reader.cancel();
  });

  test("LLM 调用失败 → 同样跳过（不命名），主流程无感", async () => {
    const factory = () =>
      (async (call) => {
        if (call.prompt.includes(TITLE_MARK)) throw new Error("llm down");
        emitText(call, "ok");
        return { text: "ok", messages: [], toolResults: [] };
      }) as ConfiguredRunPiStream;
    const { app, store } = newApp(factory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    const s = await openStream(app, c.id);
    await delay(15);
    await postMsg(app, c.id, "这是一条足够长的用户消息用于触发命名");
    await delayUntil(() => s.frames.some((f) => f.type === "done"));
    await delay(100);
    expect(store.getConversation(c.id)!.title).toBeNull(); // 失败 = 不命名，等下轮重试
    await s.reader.cancel();
  });

  test("第二轮不再重复命名", async () => {
    const n = namingFactory();
    const { app } = newApp(n.factory);
    const c: any = await (await app.request("/conversations", { method: "POST", headers: JH, body: JSON.stringify({}) })).json();
    const s = await openStream(app, c.id);
    await delay(15);
    await postMsg(app, c.id, "第一轮的素材足够长"); // ≥8 字（素材门槛）
    await delayUntil(() => s.frames.some((f) => f.type === "title"));
    await postMsg(app, c.id, "第二轮");
    await delayUntil(() => s.frames.filter((f) => f.type === "done").length >= 2);
    await delay(100);
    expect(n.prompts().filter((p) => p.includes(TITLE_MARK)).length).toBe(1); // 只首轮一次
    await s.reader.cancel();
  });
});
