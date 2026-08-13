// 沙箱 containment（ADR-0011 A1 / ticket #2）。darwin 实测 sandbox-exec/Seatbelt。
// 用真实受控 sh 进程验「隔离外部行为」（非 profile 语法细节）。linux/bwrap 在 #3；其它平台 skip。
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createServer as netServer, type AddressInfo } from "node:net";
import { writeFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { wrapSpawn } from "../src/pi/sandbox";
import { DATA_DIR, REPO_ROOT, repoSkillsDir } from "../src/config";

const isDarwin = process.platform === "darwin";
const d = isDarwin ? describe : describe.skip;

const ENVFILE = `${REPO_ROOT}.env`;
const SKILLS = repoSkillsDir();
const SKILL_MD = readdirSync(SKILLS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(SKILLS, e.name, "SKILL.md"))
  .find((p) => existsSync(p));
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

// 把 `sh -c <cmd>` 包进沙箱跑。workspace 默认建在 DATA_DIR/projects 下（faithful：验证窄 allow 覆盖宽 deny）。
async function sandboxed(ws: string, cmd: string): Promise<{ code: number | null; out: string }> {
  const plan = wrapSpawn({ argv: ["sh", "-c", cmd], cwd: ws, env: SHELL_ENV, net: "deny", allow: { rw: [ws], ro: [SKILLS] } });
  return run(plan.argv, plan.cwd, plan.env);
}
const raw = (cmd: string, cwd: string) => run(["sh", "-c", cmd], cwd, SHELL_ENV);

const newWs = (): string => {
  const ws = join(DATA_DIR, "projects", `sbtest-${globalThis.crypto.randomUUID()}`, "workspace");
  mkdirSync(ws, { recursive: true });
  return ws;
};

d("沙箱 #2 · containment（darwin / sandbox-exec）", () => {
  test("受控进程读不到仓库根 .env（带 unsandboxed 基线）", async () => {
    if (!existsSync(ENVFILE)) return expect(true).toBe(true); // 无 .env 则本断言无意义
    const ws = newWs();
    try {
      const base = await raw(`grep -c GO_API_KEY ${ENVFILE} >/dev/null && echo READ`, ws);
      expect(base.out).toContain("READ"); // 基线：确能读到（证明文件在、可读）
      const sb = await sandboxed(ws, `grep -c GO_API_KEY ${ENVFILE} >/dev/null && echo READ || echo DENIED`);
      expect(sb.out).toContain("DENIED");
      expect(sb.out).not.toContain("READ");
    } finally { rmSync(join(ws, "..", ".."), { recursive: true, force: true }); }
  });

  test("受控进程读不到 DATA_DIR 下文件（覆盖 db.sqlite；带基线）", async () => {
    const sentinel = join(DATA_DIR, `.sb-sentinel-${globalThis.crypto.randomUUID()}.txt`);
    writeFileSync(sentinel, "SUPER_SECRET_TOKEN");
    const ws = newWs();
    try {
      const base = await raw(`cat ${sentinel}`, ws);
      expect(base.out).toContain("SUPER_SECRET_TOKEN");
      const sb = await sandboxed(ws, `cat ${sentinel} 2>/dev/null`);
      expect(sb.out).not.toContain("SUPER_SECRET_TOKEN");
    } finally { unlinkSync(sentinel); rmSync(join(ws, "..", ".."), { recursive: true, force: true }); }
  });

  test("受控进程能读写自己的项目工作区", async () => {
    const ws = newWs();
    try {
      const sb = await sandboxed(ws, `echo HELLO > ${ws}/out.txt && cat ${ws}/out.txt`);
      expect(sb.code).toBe(0);
      expect(sb.out).toContain("HELLO");
    } finally { rmSync(join(ws, "..", ".."), { recursive: true, force: true }); }
  });

  test("受控进程能只读 skills、对其写被拒", async () => {
    if (!SKILL_MD) return expect(true).toBe(true);
    const ws = newWs();
    try {
      const r = await sandboxed(ws, `test -f ${SKILL_MD} && echo SKILL_READ`);
      expect(r.out).toContain("SKILL_READ");
      const w = await sandboxed(ws, `echo x > ${SKILLS}/.sb-write-test 2>/dev/null && echo WROTE || echo WDENIED`);
      expect(w.out).toContain("WDENIED");
      expect(w.out).not.toContain("WROTE");
    } finally {
      try { unlinkSync(`${SKILLS}/.sb-write-test`); } catch { /* 写被拒则文件不存在，正常 */ }
      rmSync(join(ws, "..", ".."), { recursive: true, force: true });
    }
  });

  test("受控进程不能开任何网络连接（含 127.0.0.1；带 listener 基线）", async () => {
    const srv = netServer((s) => s.end());
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const port = (srv.address() as AddressInfo).port;
    const ws = newWs();
    try {
      const base = await raw(`nc -z -w2 127.0.0.1 ${port} && echo NET_OK || echo NETFAIL`, ws);
      expect(base.out).toContain("NET_OK"); // 基线：listener 在、nc 能连
      const sb = await sandboxed(ws, `nc -z -w2 127.0.0.1 ${port} && echo NET_OK || echo NETFAIL`);
      expect(sb.out).toContain("NETFAIL");
      expect(sb.out).not.toContain("NET_OK");
    } finally { srv.close(); rmSync(join(ws, "..", ".."), { recursive: true, force: true }); }
  });

  test("受控进程不能经 symlink 逃到 .env", async () => {
    if (!existsSync(ENVFILE)) return expect(true).toBe(true);
    const ws = newWs();
    const link = join(ws, "evil.env");
    try {
      symlinkSync(ENVFILE, link);
      const sb = await sandboxed(ws, `cat ${link} 2>/dev/null | grep -c GO_API_KEY >/dev/null && echo READ || echo DENIED`);
      expect(sb.out).toContain("DENIED");
      expect(sb.out).not.toContain("READ");
    } finally { unlinkSync(link); rmSync(join(ws, "..", ".."), { recursive: true, force: true }); }
  });
});

d("沙箱 #2 · NO_SANDBOX 逃生阀（纯单元）", () => {
  test("AGENTANY_NO_SANDBOX=1 → wrapSpawn 直通（未被 sandbox-exec 包裹）", () => {
    const prev = process.env.AGENTANY_NO_SANDBOX;
    process.env.AGENTANY_NO_SANDBOX = "1";
    try {
      const plan = wrapSpawn({ argv: ["sh", "-c", "echo hi"], cwd: "/tmp", env: SHELL_ENV, net: "deny", allow: { rw: ["/tmp"], ro: [SKILLS] } });
      expect(plan.argv[0]).toBe("sh");
      expect(plan.argv).toEqual(["sh", "-c", "echo hi"]);
    } finally {
      if (prev === undefined) delete process.env.AGENTANY_NO_SANDBOX;
      else process.env.AGENTANY_NO_SANDBOX = prev;
    }
  });
});

if (!isDarwin) {
  test.skip("沙箱 seatbelt 测试仅在 darwin 运行（linux/bwrap 见 #3）", () => {});
}
