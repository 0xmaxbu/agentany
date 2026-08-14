// 会话按 workspace 分组（f2-3 Sidebar 数据形状）：纯函数，组序=workspaces 返回序、
// 组内保持传入序（GET /conversations 已是 updatedAt 倒序）、未知 workspaceId 统一落单个「默认」组排最后。
import type { ConversationRow, Workspace } from "../api";

export interface ConversationGroup {
  workspace: Workspace;
  items: ConversationRow[];
}

// 未知 ws 的兜底组（ws 列表缺失/延迟加载时防会话消失）——所有未知 id 合并为一组
const fallbackWorkspace = (): Workspace => ({
  id: "_default",
  slug: "_default",
  name: "默认",
  allUsers: false,
  createdAt: "",
  updatedAt: "",
});

export function groupByWorkspace(workspaces: Workspace[], conversations: ConversationRow[]): ConversationGroup[] {
  const groups: ConversationGroup[] = workspaces.map((w) => ({ workspace: w, items: [] }));
  const byId = new Map(groups.map((g) => [g.workspace.id, g]));
  for (const c of conversations) {
    let g = byId.get(c.workspaceId);
    if (!g) {
      g = byId.get("_default");
      if (!g) {
        g = { workspace: fallbackWorkspace(), items: [] };
        byId.set("_default", g);
        groups.push(g); // 未知组统一排在已知组之后
      }
    }
    g.items.push(c);
  }
  return groups;
}
