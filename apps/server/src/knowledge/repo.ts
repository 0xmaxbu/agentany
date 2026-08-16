// #35/M5-2 knowledge repo：运行时数据独立 git 仓库（ADR-0008 后期 / roadmap M5）。
// 与代码 repo 分离、随数据卷走；布局（#33 spec）：
//   experience/global.md            通用经验（注入全员 chat+任务 turn）
//   experience/members/<userId>.md  个人经验（按会话成员注入 chat turn；私有——无下载路由）
//   skills/<name>/experience.md     skill 级（pi --skill 原生发现，SKILL.md 已有指引）
//   learnings/                      蒸馏审计
//   distill-state.json              蒸馏水位（#36 用；本票建空态）
// 初始化只做一次（幂等）：已有 .git 即返回，不覆盖任何已写内容。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DATA_DIR, repoSkillsDir } from "../config";

export const DISTILL_STATE_FILE = "distill-state.json";
export const DISTILL_STATE_EMPTY = { processedFiles: [] as string[], lastFeedbackId: 0 };

/** knowledge repo 根：DATA_DIR/knowledge（与 general/workspaces 同层，数据卷上）。
 *  动态读 env（不引模块级 DATA_DIR const）：bun test 单进程共享模块缓存，晚设的
 *  DATA_DIR 对 const 无效——测试隔离靠每次调用现取（生产无差异：同值）。 */
export function knowledgeRoot(): string {
  return join(process.env.DATA_DIR ?? DATA_DIR, "knowledge");
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
}

/**
 * 确保 knowledge repo 就位（index.ts 启动调一次；测试可重复调）。
 * 空目录 → git init + 目录布局 + 水位空态 + skills 种子复制 + 首 commit。
 * 已是 git repo → no-op（绝不覆盖手写/蒸馏写入的内容）。
 */
export function ensureKnowledgeRepo(): void {
  const root = knowledgeRoot();
  if (existsSync(join(root, ".git"))) return;

  mkdirSync(join(root, "experience/members"), { recursive: true });
  mkdirSync(join(root, "learnings"), { recursive: true });
  writeFileSync(
    join(root, DISTILL_STATE_FILE),
    JSON.stringify(DISTILL_STATE_EMPTY, null, 2),
    "utf8",
  );
  // skills 种子：repo skills/ 整体复制（后续 skill 经验写回目标在 repo 内，代码 repo 只读不变）
  cpSync(repoSkillsDir(), join(root, "skills"), { recursive: true });

  git(["init", "-q"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "init: knowledge repo (experience/learnings/distill-state + skills seed)", "--allow-empty"], root);
}

/**
 * 收集注入 system prompt 的经验段（纯读）。
 * - global：全部调用方（chat turn + 任务 turn，D1）
 * - member：仅 chat turn（按会话归属成员）；任务语境为公司/共享工作区不注入
 * 文件缺失 → 该层跳过（不报错、不注入空段）。
 */
export function collectExperience(memberUserId?: string | null): string[] {
  const root = knowledgeRoot();
  const parts: string[] = [];
  const globalPath = join(root, "experience/global.md");
  if (existsSync(globalPath)) {
    const t = readFileSync(globalPath, "utf8").trim();
    if (t) parts.push(`[通用经验] 历史协作沉淀的可复用经验，请遵循：\n${t}`);
  }
  if (memberUserId) {
    const memberPath = join(root, "experience/members", `${memberUserId}.md`);
    if (existsSync(memberPath)) {
      const t = readFileSync(memberPath, "utf8").trim();
      if (t) parts.push(`[成员经验] 与该用户历史协作的偏好经验（仅对本人生效）：\n${t}`);
    }
  }
  return parts;
}
