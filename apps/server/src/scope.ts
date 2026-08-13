// 会话 scope（ADR-0009 / ticket #10）：project（挂项目）/ general（无项目，如公司规定）。
// scope 决定 pi 的 cwd + sessionDir；工作流是全局能力，不绑 scope（run 仍 project-scoped）。
//
// 路径真相全在 config.ts（project*/general*）；本文件只加 scope 维度的分发，
// 避免 runPi-factory 硬编码 project 路径。
import {
  assertValidProjectId, projectWorkspacePath, projectSessionDir,
  generalWorkspacePath, generalSessionDir,
} from "./config";

export type Scope = "project" | "general";

/** projectId 非空 → project；空 → general。 */
export function scopeOf(projectId: string | null | undefined): Scope {
  return projectId ? "project" : "general";
}

export interface ScopePaths {
  cwd: string;
  sessionDir: string;
}

/**
 * 按 scope 解析 pi cwd + sessionDir。
 * - general：data/general/{workspace, pi-sessions}（全用户共享的通用工作区）。
 * - project：data/projects/<projectId>/{workspace, pi-sessions}；projectId 走 assertValidProjectId（h1：路径关键输入防注入）。
 */
export function resolveScopePaths(scope: Scope, projectId?: string | null): ScopePaths {
  if (scope === "general") {
    return { cwd: generalWorkspacePath(), sessionDir: generalSessionDir() };
  }
  if (!projectId) throw new Error("resolveScopePaths: project scope requires projectId");
  assertValidProjectId(projectId); // 防穿越/绝对路径注入 cwd、sessionDir
  return { cwd: projectWorkspacePath(projectId), sessionDir: projectSessionDir(projectId) };
}
