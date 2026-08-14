// 工作空间守卫（ADR-0018）——全路由唯一鉴权口径：
//   canAccessWorkspace   = admin 短路 || ws.allUsers || 名单命中
//   canAccessConversation = admin 短路 || 创建者   （会话一律创建者私有；零 ws 查询）
//   resolveRequestWorkspace = 请求体 workspaceId 统一解析（缺省公司 ws；conversations/workflows 共用，防两处逐字重复）
import { assertValidWorkspaceId } from "../config";
import type { UserRole } from "../auth/store";
import { COMPANY_WORKSPACE_ID, type WorkspaceStore } from "./store";

/** 当前身份（= auth 中间件置入的 c.var.user；auth/middleware.principalOf 构造）。 */
export interface Principal {
  id: string;
  role: UserRole;
}

export const canAccessWorkspace = (ws: WorkspaceStore, workspaceId: string, u: Principal): boolean => {
  if (u.role === "admin") return true; // admin 全通（dev-user 即 admin → dev 流程不破）
  const w = ws.getWorkspace(workspaceId);
  if (!w) return false;
  return w.allUsers || ws.isMember(workspaceId, u.id);
};

export const canAccessConversation = (conv: { userId: string }, u: Principal): boolean =>
  u.role === "admin" || conv.userId === u.id;

export type WorkspaceResolution =
  | { ok: true; workspaceId: string }
  | { ok: false; status: 400 | 404; error: string };

/** 请求体 workspaceId 解析：缺省→公司 ws；格式→400；不存在/无权→404（存在性独立于 admin 全通——落库锚点必须真实存在）。 */
export const resolveRequestWorkspace = (ws: WorkspaceStore, raw: unknown, u: Principal): WorkspaceResolution => {
  if (typeof raw !== "string" || raw.length === 0) return { ok: true, workspaceId: COMPANY_WORKSPACE_ID };
  try {
    assertValidWorkspaceId(raw);
  } catch {
    return { ok: false, status: 400, error: "invalid workspaceId" };
  }
  if (!ws.getWorkspace(raw) || !canAccessWorkspace(ws, raw, u)) {
    return { ok: false, status: 404, error: "workspace not found" };
  }
  return { ok: true, workspaceId: raw };
};
