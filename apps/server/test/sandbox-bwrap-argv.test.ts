// bwrap argv 形状（平台无关单元，ticket #3 安全修复）：挂载面收窄——
// ~/.pi/agent 不整目录 rw bind（旧方案暴露 auth.json token + sessions transcript），
// 改 tmpfs 遮蔽 + 配置文件级 ro-bind。真机 containment 见 sandbox-bwrap.test.ts（linux 门控）。
import { describe, test, expect } from "bun:test";
import { wrapSpawnBwrap } from "../src/pi/sandbox-bwrap";

const SPEC = {
  argv: ["/usr/local/bin/pi", "-p", "x"],
  cwd: "/tmp/ws",
  env: { PATH: "/usr/bin" },
  net: "deny" as const,
  allow: { rw: ["/tmp/ws", "/tmp/ws-sessions"], ro: ["/repo/skills"] },
};

// argv 里的 flag 参数对（["--ro-bind", src, dst]...）展成 [src, dst] 对，便于断言。
function flags(args: string[], flag: string): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) out.push([args[i + 1], args[i + 2]]);
  }
  return out;
}

describe("bwrap argv 形状 · ~/.pi/agent 挂载收窄", () => {
  const plan = wrapSpawnBwrap(SPEC);
  const args = plan.argv;

  test("无整目录 rw bind ~/.pi/agent（auth.json/sessions 不可达的核心断言）", () => {
    const binds = flags(args, "--bind");
    expect(binds).toEqual([["/tmp/ws", "/tmp/ws"], ["/tmp/ws-sessions", "/tmp/ws-sessions"]]); // 只有业务 rw
  });

  test("tmpfs 遮蔽 ~/.pi/agent（pi 可写锁文件、易失；真目录内容不可见）", () => {
    // --tmpfs 是单参数 flag（非 bind 对）
    const tmpfs = args.filter((_, i) => args[i - 1] === "--tmpfs");
    expect(tmpfs).toContain(`${process.env.HOME}/.pi/agent`);
  });

  test("pi 运行所需配置文件级 ro-bind（settings/models/models-store/extensions）", () => {
    const ro = flags(args, "--ro-bind").map(([src]) => src);
    expect(ro).toContain(`${process.env.HOME}/.pi/agent/settings.json`);
    expect(ro).toContain(`${process.env.HOME}/.pi/agent/models.json`);
  });

  test("argv 任何参数不含 auth.json / sessions（deny 也不挂——bwrap 不挂即不存在）", () => {
    expect(args.some((a) => a.includes("auth.json"))).toBe(false);
    expect(args.some((a) => a.includes("/sessions"))).toBe(false);
  });
});
