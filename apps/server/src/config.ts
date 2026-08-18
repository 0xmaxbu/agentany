import { join, resolve, sep } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";

// h1：workspaceId 是构建文件系统路径的关键输入，必须严格校验（防 ../../、绝对路径注入 cwd/sessionDir）。
export class InvalidWorkspaceId extends Error {
  constructor(id: string) { super(`invalid workspaceId: ${JSON.stringify(id)}`); this.name = "InvalidWorkspaceId"; }
}
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function assertValidWorkspaceId(workspaceId: string): void {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_RE.test(workspaceId)) throw new InvalidWorkspaceId(workspaceId);
  // 纵深防御：解析后仍须落在 DATA_DIR/workspaces/ 下。
  const root = resolve(DATA_DIR, "workspaces");
  const resolved = resolve(root, workspaceId);
  if (resolved !== root && !resolved.startsWith(root + sep)) throw new InvalidWorkspaceId(workspaceId);
}

// h2：把自由文本拍成安全路径段（brand/region 进文件系统路径前用它）。
// 保留 CJK/unicode（品牌名/地区常用中文），只移除路径与 shell 危险字符 + 防穿越。
export function slugify(s: unknown): string {
  const t = String(s ?? "")
    .replace(/[\/\\:*?"<>|;&`$(){}\[\]^#!~]/g, "_") // 路径/shell 危险字符
    .replace(/\.\.+/g, "_")                          // 防穿越
    .replace(/^\.+/, "")                             // 去前导点
    .replace(/[\x00-\x1f]/g, "")                     // 去控制字符
    .trim();
  return t.slice(0, 128) || "x";
}

// 本文件在 apps/server/src/config.ts → 仓库根 = ../../../
// decodeURIComponent：仓库路径含空格/非 ASCII（worktree 目录带空格实测）时 URL.pathname 返回 %20 编码——
// 编码串不是合法文件路径（skills/data 全断）。与 db/client.ts MIGRATIONS_FOLDER 同源修复。
export const REPO_ROOT = decodeURIComponent(new URL("../../../", import.meta.url).pathname);
// skills 根（沙箱只读挂载；ADR-0005 自动发现）。
export const repoSkillsDir = (): string => `${REPO_ROOT}skills`;

// 加载仓库根 .env（set-if-unset）。Bun 默认只读 cwd 的 .env；服务/runPi 可能从任意 cwd 启动。
try {
  for (const line of readFileSync(`${REPO_ROOT}.env`, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
} catch {
  /* 无 .env 忽略 */
}

// 运行时数据根（ADR-0006：data/ gitignored，放仓库根）。ENV 可覆盖。
export const DATA_DIR = resolve(process.env.DATA_DIR ?? `${REPO_ROOT}data`);

export const PORT = Number(process.env.PORT ?? 3000);

// 飞书通道（spec #55/T1）：应用机器人凭证（企业自建应用）。两者皆设 → index 接线飞书出站；缺一 → 无飞书（零侵入）。
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID ?? "";
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET ?? "";

// 工作空间工作区 / Pi session 目录（ADR-0018：ws=目录锚的唯一单位）。runPi-factory 与 workflow steps 共用。
/** DATA_DIR 动态取值（#37 坑：模块级 const 在 bun test 单进程下晚设 env 无效；生产同值无差异）。 */
export const dataDir = (): string => process.env.DATA_DIR ?? DATA_DIR;

export const workspaceWorkspacePath = (workspaceId: string): string =>
  resolve(dataDir(), "workspaces", workspaceId, "workspace");
export const workspaceSessionDir = (workspaceId: string): string =>
  resolve(dataDir(), "workspaces", workspaceId, "pi-sessions");

// 通用（公司 workspace ws_company）工作区 / Pi session 目录（ADR-0009 general 沿用；ADR-0018）。
export const generalWorkspacePath = (): string => resolve(dataDir(), "general", "workspace");
export const generalSessionDir = (): string => resolve(dataDir(), "general", "pi-sessions");

// #39/ADR-0023：system 任务专属 session 目录（data/tasks/<taskId>/pi-sessions）。
// 不复用 generalSessionDir——那是 chat 会话共用区，任务 pi 会 ls 到其它成员会话历史（历史域排除）。
export const taskSessionDir = (taskId: string): string =>
  resolve(dataDir(), "tasks", taskId, "pi-sessions");

// 仓库根（skill/extension 绝对路径解析用）。
export const repoSkillsPath = (name: string): string => `${REPO_ROOT}skills/${name}`;
export const repoExtensionPath = (sub: string): string => `${REPO_ROOT}skills/${sub}`;
// chat turn 专属扩展（repo 根 chat/，【不进 skills/】——非 LLM 可读区；ADR-0009 / ticket #12）。
export const chatExtensionPath = (sub: string): string => `${REPO_ROOT}chat/${sub}`;

// 自动发现：repo/skills/ 下每个含 SKILL.md 的子目录（ADR-0005：skills 全量标准发现、不策展）。
// dev 无沙箱用 --skill <每个>；沙箱上线后换 ro-bind repo/skills → workspace/.pi/skills（去掉 --skill）。
export function repoSkillPaths(): string[] {
  // #37/Spec-3：knowledge 副本优先（蒸馏写回的 skills/<name>/experience.md 在副本——pi 读它才闭环）；
  // 副本缺席（测试 DATA_DIR 未建 knowledge）回落代码仓种子。
  const dir = existsSync(join(dataDir(), "knowledge", "skills"))
    ? join(dataDir(), "knowledge", "skills")
    : `${REPO_ROOT}skills`;
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => `${dir}/${d.name}`)
      .filter((p) => existsSync(`${p}/SKILL.md`));
  } catch {
    return [];
  }
}
