// bridge #11：nonce 闸 + 沙箱端口级 loopback 放行（ADR-0012 窄修正）。
// darwin 实测 sandbox-exec + 真 bridge Hono。非 darwin skip（bwrap/linux 见 #3、A4）。
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createServer as netServer, type AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { wrapSpawn } from "../src/pi/sandbox";
import { DATA_DIR, repoSkillsDir } from "../src/config";
import { startBridge } from "../src/bridge/server";
import { issueNonce, revokeNonce, verifyNonce, _clearNonces, _nonceCount, _setMaxNonces } from "../src/bridge/nonce";

const isDarwin = process.platform === "darwin";
const d = isDarwin ? describe : describe.skip;
const SKILLS = repoSkillsDir();
const SHELL_ENV = { PATH: process.env.PATH!, HOME: process.env.HOME! };

function run(argv: string[], cwd: string, env: Record<string, string | undefined>): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const p = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c.toString()));
    p.stderr.on("data", (c) => (out += c.toString()));
    p.on("error", (e) => res({ code: -1, out: String(e) }));
    p.on("close", (code) => res({ code, out }));
  });
}

// 沙箱内跑 sh -c <cmd>；loopbackPorts 控制端口级 loopback 放行（默认 undefined=全拒）。
async function sandboxed(ws: string, cmd: string, loopbackPorts?: number[]) {
  const plan = wrapSpawn({ argv: ["sh", "-c", cmd], cwd: ws, env: SHELL_ENV, net: "deny", loopbackPorts, allow: { rw: [ws], ro: [SKILLS] } });
  return run(plan.argv, plan.cwd, plan.env);
}

const newWs = (): string => {
  const ws = join(DATA_DIR, "projects", `sbbridge-${globalThis.crypto.randomUUID()}`, "workspace");
  mkdirSync(ws, { recursive: true });
  return ws;
};

d("bridge #11 · nonce 闸 + 沙箱端口级放行（darwin）", () => {
  test("/ping：无 nonce → 401；坏 nonce → 401；有效 nonce → 200", async () => {
    const { port, stop } = startBridge(0);
    const token = issueNonce("c-test");
    try {
      const noAuth = await fetch(`http://127.0.0.1:${port}/ping`);
      expect(noAuth.status).toBe(401);
      const bad = await fetch(`http://127.0.0.1:${port}/ping`, { headers: { authorization: "Bearer not-a-nonce" } });
      expect(bad.status).toBe(401);
      const ok = await fetch(`http://127.0.0.1:${port}/ping`, { headers: { authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).ok).toBe(true);
    } finally { stop(); _clearNonces(); }
  });

  test("nonce 吊销后 → 401（turn 末吊销语义）", async () => {
    const { port, stop } = startBridge(0);
    const token = issueNonce("c-test");
    try {
      expect((await fetch(`http://127.0.0.1:${port}/ping`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
      revokeNonce(token);
      expect((await fetch(`http://127.0.0.1:${port}/ping`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    } finally { stop(); _clearNonces(); }
  });

  test("沙箱内 curl bridge /ping（loopbackPorts 放行 + 有效 nonce）→ 200", async () => {
    const { port, stop } = startBridge(0);
    const token = issueNonce("c-test");
    const ws = newWs();
    try {
      const cmd = `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${token}" http://localhost:${port}/ping`;
      const r = await sandboxed(ws, cmd, [port]);
      expect(r.out.trim()).toBe("200");
    } finally { stop(); _clearNonces(); rmSync(join(ws, "..", ".."), { recursive: true, force: true }); }
  });

  test("沙箱内 curl 127.0.0.1:<port>/ping（裸 IP，非 localhost）→ 200（实证 seatbelt 的 localhost token 覆盖 127.0.0.1 直连）", async () => {
    const { port, stop } = startBridge(0);
    const token = issueNonce("c-test");
    const ws = newWs();
    try {
      const cmd = `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${token}" http://127.0.0.1:${port}/ping`;
      const r = await sandboxed(ws, cmd, [port]);
      expect(r.out.trim()).toBe("200");
    } finally { stop(); _clearNonces(); rmSync(join(ws, "..", ".."), { recursive: true, force: true }); }
  });

  test("沙箱内 curl 非 bridge 端口（3000 类公共路由，不在 loopbackPorts）→ 连不上（非 200）", async () => {
    const srv = netServer((s) => s.end());
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const otherPort = (srv.address() as AddressInfo).port;
    const { port: bridgePort, stop } = startBridge(0); // 只放行 bridgePort，otherPort 不放
    issueNonce("c-test");
    const ws = newWs();
    try {
      const cmd = `curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:${otherPort}/ || echo DENIED`;
      const r = await sandboxed(ws, cmd, [bridgePort]);
      expect(r.out).not.toContain("200");
    } finally { srv.close(); stop(); _clearNonces(); rmSync(join(ws, "..", ".."), { recursive: true, force: true }); }
  });

  test("默认无 loopbackPorts → 连 bridge 也拒（默认全拒不变，回归保护）", async () => {
    const { port, stop } = startBridge(0);
    const token = issueNonce("c-test");
    const ws = newWs();
    try {
      const cmd = `curl -s -o /dev/null -w "%{http_code}" --max-time 3 -H "Authorization: Bearer ${token}" http://localhost:${port}/ping || echo DENIED`;
      const r = await sandboxed(ws, cmd, undefined);
      expect(r.out).not.toContain("200");
    } finally { stop(); _clearNonces(); rmSync(join(ws, "..", ".."), { recursive: true, force: true }); }
  });
});

describe("bridge #11 · nonce 清退（纯逻辑，全平台）", () => {
  test("revokeNonce 删除条目 → verifyNonce false、计数减", () => {
    _clearNonces();
    const t = issueNonce("c1");
    expect(verifyNonce(t)).toBe(true);
    expect(_nonceCount()).toBe(1);
    revokeNonce(t);
    expect(verifyNonce(t)).toBe(false);
    expect(_nonceCount()).toBe(0);
  });

  test("超 cap → 淘汰最老（插入序），有上限不无界增长", () => {
    _clearNonces();
    _setMaxNonces(3);
    try {
      const a = issueNonce("c1");
      issueNonce("c2");
      issueNonce("c3");
      expect(_nonceCount()).toBe(3);
      issueNonce("c4"); // 超 cap → 淘汰最老 a
      expect(_nonceCount()).toBe(3);
      expect(verifyNonce(a)).toBe(false); // 最老被淘汰
    } finally {
      _setMaxNonces(Number(process.env.BRIDGE_MAX_NONCES ?? 10_000));
      _clearNonces();
    }
  });
});

if (!isDarwin) {
  test.skip("bridge 沙箱测试仅在 darwin 运行（linux/bwrap 见 #3、A4）", () => {});
}
