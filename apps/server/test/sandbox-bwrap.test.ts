// 沙箱 containment · linux/bwrap（ticket #3 / M3a）。
// 镜像 darwin 套件（sandbox.test.ts）的文件系统断言；网络断言见网络对等票（pasta）——linux 侧 skip。
// 跑法：Linux 装好 bwrap 后 `bun test test/sandbox-bwrap.test.ts`；darwin skip。
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { wrapSpawn } from "../src/pi/sandbox";
import { DATA_DIR, REPO_ROOT, repoSkillsDir } from "../src/config";

const isLinux = process.platform === "linux";
const l = isLinux ? describe : describe.skip;

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

// 与 darwin 套件同构：`sh -c <cmd>` 包进沙箱跑（net=deny 走 bwrap 主机网络——网络断言拆票，此处只验 fs）。
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

l("沙箱 #3 · containment（linux / bwrap）", () => {
  test("受控进程读不到仓库根 .env（带 unsandboxed 基线）", async () => {
    if (!existsSync(ENVFILE)) return expect(true).toBe(true);
    const ws = newWs();
    try {
      const base = await raw(`grep -c GO_API_KEY ${ENVFILE} >/dev/null && echo READ`, ws);
      expect(base.out).toContain("READ");
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

  // ⚠ 网络断言（nc 127.0.0.1 拒 / bridge 端口窄放行）在 linux 侧暂缺——bwrap 网络全有/全无，
  // 对等方案=pasta 拥有 netns + bwrap 仅 fs 隔离 + 网关地址访问 host loopback（见网络对等票）。
  // 落地前：真 auth + bridge nonce 是 loopback 唯一防线（ADR-0012 已记）。
});

if (!isLinux) {
  test.skip("沙箱 bwrap 测试仅在 linux 运行（darwin/Seatbelt 见 sandbox.test.ts）", () => {});
}
