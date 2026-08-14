// 会话/run 的 workspace scope（ADR-0018）：WORKSPACE=作用域+权限唯一原子单位。
//
// 目录锚（纯函数，不查表）：ws_company（公司默认 ws）→ data/general/（原 general 通道沿用，文件零迁移）；
// 其余 → data/workspaces/<workspaceId>/。路径真相全在 config.ts；本文件只做 scope 维度分发。
import {
  assertValidWorkspaceId, workspaceWorkspacePath, workspaceSessionDir,
  generalWorkspacePath, generalSessionDir,
} from "./config";
import { COMPANY_WORKSPACE_ID } from "./workspaces/store";

export type Scope = "workspace" | "general";

/** 公司 ws → general（data/general/）；其余 → workspace（data/workspaces/<id>）。 */
export function scopeOf(workspaceId: string | null | undefined): Scope {
  return workspaceId === COMPANY_WORKSPACE_ID ? "general" : "workspace";
}

export interface ScopePaths {
  cwd: string;
  sessionDir: string;
}

/**
 * 按 scope 解析 pi cwd + sessionDir。
 * - general：公司 workspace（ws_company）→ data/general/{workspace, pi-sessions}。
 * - workspace：data/workspaces/<workspaceId>/；workspaceId 走 assertValidWorkspaceId（h1：防注入）。
 */
export function resolveScopePaths(scope: Scope, workspaceId?: string | null): ScopePaths {
  if (scope === "general") {
    return { cwd: generalWorkspacePath(), sessionDir: generalSessionDir() };
  }
  if (!workspaceId) throw new Error("resolveScopePaths: workspace scope requires workspaceId");
  assertValidWorkspaceId(workspaceId); // 防穿越/绝对路径注入 cwd、sessionDir
  return { cwd: workspaceWorkspacePath(workspaceId), sessionDir: workspaceSessionDir(workspaceId) };
}
