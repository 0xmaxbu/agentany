// ticket #17：loadProjectDoc（PROJECT.md 项目记忆）。tmpdir 隔离，不碰真实 data/。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectDoc, PROJECT_TEMPLATE } from "../src/chat/project-doc";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pjdoc-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("project-doc · loadProjectDoc（#17）", () => {
  test("missing → 建工作区 + 写模板 + 返模板内容（idempotent：再调不覆盖）", () => {
    const cwd = join(dir, "ws"); // 工作区不存在
    const content = loadProjectDoc(cwd);
    expect(existsSync(join(cwd, "PROJECT.md"))).toBe(true); // 建了工作区 + 文件
    expect(content).toBe(PROJECT_TEMPLATE);
    expect(loadProjectDoc(cwd)).toBe(PROJECT_TEMPLATE); // 再调 idempotent
  });

  test("existing → 返原内容（不覆盖用户内容）", () => {
    const cwd = join(dir, "ws");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "PROJECT.md"), "# 我的项目的\n自定义内容", "utf8");
    const content = loadProjectDoc(cwd);
    expect(content).toContain("自定义内容");
    expect(content).not.toBe(PROJECT_TEMPLATE); // 未覆盖
  });

  test("项目级 vs 通用级：同一函数，由传入 cwd 区分", () => {
    const projCwd = join(dir, "projects", "p1", "workspace");
    const genCwd = join(dir, "general", "workspace");
    loadProjectDoc(projCwd);
    loadProjectDoc(genCwd);
    expect(existsSync(join(projCwd, "PROJECT.md"))).toBe(true);
    expect(existsSync(join(genCwd, "PROJECT.md"))).toBe(true);
  });
});
