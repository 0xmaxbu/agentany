// ticket #17：项目记忆 PROJECT.md。pi 不自动加载 PROJECT.md（默认认 AGENTS.md），故每轮注入。
// loadProjectDoc(workspaceCwd)：mkdir -p + 缺则写模板 + 返内容（idempotent）。
// turn.ts 传 resolveScopePaths(scopeOf(workspaceId), workspaceId).cwd —— 公司 ws/其余 ws 由 cwd 区分（已过 assertValidWorkspaceId）。
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_TEMPLATE = `# 项目背景（PROJECT.md）

> 本文件是项目记忆，**每轮对话会注入给 AI**。请填写项目背景、目标、约束、术语等，让 AI 回应有据可依。
> workspace 级：仅当前 workspace 可见；公司级（公司 workspace）：全员共享（如公司规定、通用规范）。

## 项目概述
（待填写：这是什么项目、服务谁、解决什么问题）

## 目标
（待填写：本会话/本阶段想达成什么）

## 约束 / 规范
（待填写：必须遵守的规则、风格、禁区）

## 术语表
（待填写：领域专有名词 + 含义）
`;

const FILENAME = "PROJECT.md";

/** idempotent：确保工作区存在 + PROJECT.md 缺则写模板，返文件内容。 */
export function loadProjectDoc(workspaceCwd: string): string {
  mkdirSync(workspaceCwd, { recursive: true });
  const path = join(workspaceCwd, FILENAME);
  if (!existsSync(path)) writeFileSync(path, PROJECT_TEMPLATE, "utf8");
  return readFileSync(path, "utf8");
}
