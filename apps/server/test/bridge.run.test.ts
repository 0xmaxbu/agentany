// ticket #14：bridge /run/start + /run/read（nonce→conversationId→RunRegistry）。
import { describe, test, expect } from "bun:test";
import { startBridge } from "../src/bridge/server";
import { issueNonce, _clearNonces } from "../src/bridge/nonce";
import { RunRegistry } from "../src/runs/registry";
import { EventBus } from "../src/chat/eventbus";
import { WorkflowStore } from "../src/workflow-engine/store";
import { openDbMigrated } from "../src/db/client";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (p: () => boolean, t = 3000) => {
  const s = Date.now();
  while (Date.now() - s < t) { if (p()) return; await delay(10); }
};

function setup() {
  const store = new WorkflowStore(openDbMigrated(":memory:"));
  store.createConversation({ id: "c-bridge", workspaceId: "ws_company", userId: "u" });
  const eventBus = new EventBus();
  const registry = new RunRegistry({ store, eventBus, runPiFactory: stubFactory });
  return { store, eventBus, registry };
}

describe("bridge /run/start + /run/read（ticket #14）", () => {
  test("/run/start（有效 nonce）→ {runId, running}；/run/read → suspended（synthetic 挂起）", async () => {
    const { store, eventBus, registry } = setup();
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-bridge");
    try {
      const r = await fetch(`http://127.0.0.1:${port}/run/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ workflowId: "synthetic-3step", input: {} }),
      });
      expect(r.status).toBe(200);
      const data: any = await r.json();
      expect(data.status).toBe("running");
      expect(data.runId).toBeTruthy();

      await delayUntil(() => registry.read(data.runId)?.status === "suspended");
      const rd = await fetch(`http://127.0.0.1:${port}/run/read?runId=${data.runId}`, { headers: { authorization: `Bearer ${token}` } });
      expect(rd.status).toBe(200);
      expect(((await rd.json()) as any).status).toBe("suspended");
    } finally {
      stop();
      _clearNonces();
    }
  });

  test("无 nonce / 坏 nonce → 401", async () => {
    const { store, eventBus, registry } = setup();
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    try {
      const noAuth = await fetch(`http://127.0.0.1:${port}/run/start`, { method: "POST", body: "{}" });
      expect(noAuth.status).toBe(401);
      const bad = await fetch(`http://127.0.0.1:${port}/run/start`, { method: "POST", headers: { authorization: "Bearer bad" }, body: "{}" });
      expect(bad.status).toBe(401);
    } finally {
      stop();
      _clearNonces();
    }
  });

  test("read 不存在的 run → 404；缺 workflowId → 400", async () => {
    const { store, eventBus, registry } = setup();
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-bridge");
    try {
      const rd = await fetch(`http://127.0.0.1:${port}/run/read?runId=nope`, { headers: { authorization: `Bearer ${token}` } });
      expect(rd.status).toBe(404);
      const noWf = await fetch(`http://127.0.0.1:${port}/run/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(noWf.status).toBe(400);
    } finally {
      stop();
      _clearNonces();
    }
  });

  test("#18 /run/start 透传三态：brand-research（auto=require_approval）→ {needs_approval, questionId}（不 throw）", async () => {
    const { store, eventBus, registry } = setup();
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const token = issueNonce("c-bridge");
    try {
      const r = await fetch(`http://127.0.0.1:${port}/run/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ workflowId: "brand-research", input: { brand: "x" } }),
      });
      expect(r.status).toBe(200); // needs_approval 是返回值，非 throw
      const data: any = await r.json();
      expect(data.status).toBe("needs_approval");
      expect(data.questionId).toBeGreaterThan(0);
      expect(store.getPendingApproval("c-bridge", "brand-research")?.id).toBe(data.questionId);
    } finally {
      stop();
      _clearNonces();
    }
  });

  test("#codex /run/read 跨会话 guard：B 的 nonce 读 A 的 run → 403（同 /ask_user /run/resume）；A 自读 → 200", async () => {
    const { store, eventBus, registry } = setup();
    store.createConversation({ id: "c-other", workspaceId: "ws_company", userId: "u" });
    const { port, stop } = startBridge(0, { runRegistry: registry, store, eventBus });
    const tokenA = issueNonce("c-bridge");
    try {
      // A（c-bridge）起一个 run
      const r = await fetch(`http://127.0.0.1:${port}/run/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
        body: JSON.stringify({ workflowId: "synthetic-3step", input: {} }),
      });
      const data: any = await r.json();
      expect(data.runId).toBeTruthy();
      // B（c-other）的 nonce 读 A 的 run → 403（nonce 是唯一授权，不得跨会话读）
      const tokenB = issueNonce("c-other");
      const cross = await fetch(`http://127.0.0.1:${port}/run/read?runId=${data.runId}`, { headers: { authorization: `Bearer ${tokenB}` } });
      expect(cross.status).toBe(403);
      // A 自读 → 200（回归）
      const ok = await fetch(`http://127.0.0.1:${port}/run/read?runId=${data.runId}`, { headers: { authorization: `Bearer ${tokenA}` } });
      expect(ok.status).toBe(200);
    } finally {
      stop();
      _clearNonces();
    }
  });
});
