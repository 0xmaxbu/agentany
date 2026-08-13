// chat-bridge 扩展（ticket #12）。纯逻辑（bridge-core）+ 接线 + 沙箱可读。
// 真 pi 调 ping 工具归 #19 冒烟；本票验：通道调用逻辑正确、接线对、pi 在沙箱内读得到扩展。
import { describe, test, expect, mock } from "bun:test";
import { spawn } from "node:child_process";
import { readBridgeEnv, pingBridge, startWorkflow, readRun, askUser, resumeWorkflow, withBridge } from "../../../chat/extensions/bridge-core";
import { CHAT_EXTENSIONS } from "../src/chat/extensions";
import { repoSkillPaths, chatExtensionPath, repoSkillsDir } from "../src/config";
import { listWorkflows, getWorkflow } from "../src/registry";
import { wrapSpawn } from "../src/pi/sandbox";

const isDarwin = process.platform === "darwin";
const d = isDarwin ? describe : describe.skip;
const SHELL_ENV = { PATH: process.env.PATH!, HOME: process.env.HOME! };

describe("chat-bridge · 纯逻辑（bridge-core）", () => {
  test("readBridgeEnv：URL+NONCE 齐全 → 返回；缺任一 → null", () => {
    expect(readBridgeEnv({ AGENTANY_BRIDGE_URL: "http://x", AGENTANY_BRIDGE_NONCE: "n" })).toEqual({ url: "http://x", nonce: "n" });
    expect(readBridgeEnv({ AGENTANY_BRIDGE_URL: "http://x" })).toBeNull();
    expect(readBridgeEnv({})).toBeNull();
  });

  test("pingBridge → GET <url>/ping + Bearer nonce，返回 status+body", async () => {
    const orig = globalThis.fetch;
    const fetchMock = mock((_input: string, _init?: RequestInit) =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve("") } as unknown as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const out = await pingBridge({ url: "http://localhost:3199", nonce: "n-xyz" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:3199/ping");
      expect((init?.headers as any)?.authorization).toBe("Bearer n-xyz");
      expect(out).toContain("200");
      expect(out).toContain('"ok":true');
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("pingBridge → 非 200（如 401）如实返回 status，不抛", async () => {
    const orig = globalThis.fetch;
    const fetchMock = mock((_input: string, _init?: RequestInit) =>
      Promise.resolve({ status: 401, json: () => Promise.resolve({ error: "unauthorized" }), text: () => Promise.resolve("") } as unknown as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const out = await pingBridge({ url: "http://localhost:3199", nonce: "bad" });
      expect(out).toContain("401");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("chat-bridge · 接线（#12）", () => {
  test("CHAT_EXTENSIONS 含 chat-bridge + tavily", () => {
    expect(CHAT_EXTENSIONS.some((e) => e.endsWith("chat/extensions/chat-bridge.ts"))).toBe(true);
    expect(CHAT_EXTENSIONS.some((e) => e.endsWith("tavily-search/extensions/web-search.ts"))).toBe(true);
  });

  test("chat-bridge 不被 skills 自动发现（repoSkillPaths 只扫 skills/）", () => {
    expect(repoSkillPaths().every((p) => !p.includes("/chat/"))).toBe(true);
  });

  test("工作流 agent 步不注入 chat-bridge（只 chat turn）", () => {
    for (const w of listWorkflows()) {
      const exts = getWorkflow(w.id)!.extensions ?? [];
      expect(exts.some((e) => e.includes("chat-bridge"))).toBe(false);
    }
  });
});

describe("chat-bridge · bridge-core startWorkflow / readRun（ticket #14）", () => {
  test("startWorkflow → POST <url>/run/start + Bearer + JSON body", async () => {
    const orig = globalThis.fetch;
    const fetchMock = mock((_input: string, _init?: RequestInit) =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ runId: "r1", status: "running" }), text: () => Promise.resolve("") } as unknown as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const out = await startWorkflow({ url: "http://localhost:3199", nonce: "n" }, "synthetic-3step", { offset: 1 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:3199/run/start");
      expect((init as RequestInit).method).toBe("POST");
      expect(((init as RequestInit).headers as any).authorization).toBe("Bearer n");
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ workflowId: "synthetic-3step", input: { offset: 1 } });
      expect(out).toContain("200");
      expect(out).toContain("running");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("readRun → GET <url>/run/read?runId= + Bearer", async () => {
    const orig = globalThis.fetch;
    const fetchMock = mock((_input: string, _init?: RequestInit) =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ runId: "r1", status: "suspended" }), text: () => Promise.resolve("") } as unknown as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const out = await readRun({ url: "http://localhost:3199", nonce: "n" }, "r1");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:3199/run/read?runId=r1");
      expect(((init as RequestInit).headers as any).authorization).toBe("Bearer n");
      expect(out).toContain("suspended");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("chat-bridge · askUser / resumeWorkflow（ticket #16）", () => {
  test("askUser → POST <url>/ask_user + Bearer + JSON body", async () => {
    const orig = globalThis.fetch;
    const fetchMock = mock((_input: string, _init?: RequestInit) =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ status: "asked", questionId: 1 }), text: () => Promise.resolve("") } as unknown as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const out = await askUser({ url: "http://localhost:3199", nonce: "n" }, { runId: "r1", prompt: "选？", options: ["A", "B"] });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:3199/ask_user");
      expect((init as RequestInit).method).toBe("POST");
      expect(((init as RequestInit).headers as any).authorization).toBe("Bearer n");
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ runId: "r1", prompt: "选？", options: ["A", "B"] });
      expect(out).toContain("asked");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("resumeWorkflow → POST <url>/run/resume + Bearer + JSON body", async () => {
    const orig = globalThis.fetch;
    const fetchMock = mock((_input: string, _init?: RequestInit) =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ status: "completed" }), text: () => Promise.resolve("") } as unknown as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const out = await resumeWorkflow({ url: "http://localhost:3199", nonce: "n" }, "r1", { decision: "accept" });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:3199/run/resume");
      expect((init as RequestInit).method).toBe("POST");
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ runId: "r1", resumeData: { decision: "accept" } });
      expect(out).toContain("completed");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("chat-bridge · withBridge（去重 helper，bridge-core）", () => {
  test("无 bridge env → isError 文本（fn 不被调）", async () => {
    let called = false;
    const r: any = await withBridge("ping", {}, async () => { called = true; return "x"; });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("未注入");
    expect(called).toBe(false);
  });

  test("有 env：fn 成功 → text；fn 抛 → isError 含 message", async () => {
    const env = { AGENTANY_BRIDGE_URL: "http://x", AGENTANY_BRIDGE_NONCE: "n" };
    const ok: any = await withBridge("ping", env, async () => "PONG");
    expect(ok.content[0].text).toBe("PONG");
    expect(ok.isError).toBeUndefined();
    const bad: any = await withBridge("ping", env, async () => { throw new Error("boom"); });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("boom");
  });
});

d("chat-bridge · 沙箱可读扩展（darwin）", () => {
  test("ro 含 chat/extensions → 沙箱内能读 chat-bridge.ts（pi 方能 -e 加载）", async () => {
    const ext = chatExtensionPath("extensions/chat-bridge.ts");
    const extDir = ext.slice(0, ext.lastIndexOf("/")); // .../chat/extensions
    const plan = wrapSpawn({
      argv: ["sh", "-c", `grep -c registerTool ${ext} >/dev/null && echo READ || echo DENIED`],
      cwd: "/tmp", env: SHELL_ENV, net: "deny",
      allow: { rw: ["/tmp"], ro: [repoSkillsDir(), extDir] },
    });
    const out: string = await new Promise((res) => {
      const p = spawn(plan.argv[0], plan.argv.slice(1), { cwd: plan.cwd, env: plan.env, stdio: ["ignore", "pipe", "pipe"] });
      let o = "";
      p.stdout.on("data", (c) => (o += c.toString()));
      p.stderr.on("data", (c) => (o += c.toString()));
      p.on("close", () => res(o));
    });
    expect(out).toContain("READ");
  });
});

if (!isDarwin) {
  test.skip("chat-bridge 沙箱可读测试仅在 darwin 运行", () => {});
}
