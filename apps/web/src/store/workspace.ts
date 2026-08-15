// workspace store（f2 拆分② → #手风琴重构）：ws 列表（含活跃度聚合）+ 每 ws 分页会话。
// 模型：首屏只拉公司 ws 的 conversations（limit 10）；其他组首次展开懒加载；各组「加载更多」offset 续拉。
// 搜索态：有 query 时全量拉本地过滤（清空回分页态）。
// #21/ADR-0020：archivedConversations 归档列表 + archive/restore/remove。
import { create } from "zustand";
import { archiveConversation, deleteConversation, listConversations, listWorkspaces, restoreConversation, type ConversationRow, type Workspace } from "../api";

export const PAGE_SIZE = 5; // 组内直显条数（#手风琴-2；全部会话走弹窗）

/** 每 ws 组的会话分页态（#手风琴）。items=已加载（updatedAt 倒序）；exhausted=加载更多隐藏。 */
interface GroupState {
  items: ConversationRow[];
  exhausted: boolean; // items.length < 已知总数（加载更多后 == true 表示无更多）
  loaded: boolean; // 首次懒加载是否已发生（false=组从未展开）
}

interface WorkspaceState {
  workspaces: Workspace[]; // 已按排序规则排好（公司置顶 + lastActiveAt 倒序）
  groups: Record<string, GroupState>; // workspaceId → 分页态
  loaded: boolean;
  query: string; // 侧栏搜索（空=分页态；非空=全量过滤态）
  searchAll: ConversationRow[] | null; // 搜索态的全量会话（query 清空即弃）
  archivedConversations: ConversationRow[]; // #21 归档区
  load: () => Promise<void>; // 首载：ws 列表 + 公司组第一页
  expandGroup: (workspaceId: string) => Promise<void>; // 首次展开懒加载（已 loaded 则 no-op）
  loadMore: (workspaceId: string) => Promise<void>; // 加载更多（offset += PAGE_SIZE）
  setQuery: (q: string) => Promise<void>; // 搜索：非空全量拉；空回分页态
  refreshConversations: () => Promise<void>; // 发消息后（touch 变 updatedAt 顺序）——刷新已展开组首页
  refreshArchived: () => Promise<void>; // 归档区展开时按需拉
  /** 建会话后本地 prepend（乐观——目标组顶部 + ws 活跃度更新）。 */
  prependConversation: (c: ConversationRow) => void;
  /** #21 归档：本地即时下架 + 落库（失败回滚）。 */
  archive: (id: string) => Promise<void>;
  /** #21 恢复：本地即时移出归档区 + 已展开组刷新（失败回滚）。 */
  restore: (id: string) => Promise<void>;
  /** #21 admin 硬删：后端全链清理；本地移除。 */
  remove: (id: string) => Promise<void>;
}

const without = (arr: ConversationRow[], id: string) => arr.filter((c) => c.id !== id);

/** ws 组显示序：公司置顶；其余按 lastActiveAt 倒序——**有活动的排无活动的前面**，
 * 无会话（lastActiveAt=null）互相按 updatedAt 倒序（近建在前）兜底。 */
export function sortWorkspaces(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort((a, b) => {
    const aCompany = a.id === COMPANY_WORKSPACE_ID ? 0 : 1;
    const bCompany = b.id === COMPANY_WORKSPACE_ID ? 0 : 1;
    if (aCompany !== bCompany) return aCompany - bCompany;
    // 有活动 > 无活动（grill Q3：无会话的 ws 排有活动的后面）
    const aActive = a.lastActiveAt != null ? 0 : 1;
    const bActive = b.lastActiveAt != null ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    const ka = a.lastActiveAt ?? a.updatedAt;
    const kb = b.lastActiveAt ?? b.updatedAt;
    return kb.localeCompare(ka);
  });
}

// 公司 ws 固定 id（迁移 seed；后端 workspaces/store.ts 同源常量——web 侧唯一引用点）
export const COMPANY_WORKSPACE_ID = "ws_company";

/** 组内会话排序：updatedAt 倒序（后端已排，prepend 后本地也要保持）。 */
const byUpdatedDesc = (a: ConversationRow, b: ConversationRow) => b.updatedAt.localeCompare(a.updatedAt);

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  groups: {},
  loaded: false,
  query: "",
  searchAll: null,
  archivedConversations: [],

  load: async () => {
    const wss = await listWorkspaces().catch(() => []);
    const sorted = sortWorkspaces(wss);
    set({ workspaces: sorted, loaded: true });
    // 公司组首屏加载第一页（其他组懒加载）
    const first = await listConversations(false, { workspaceId: COMPANY_WORKSPACE_ID, limit: PAGE_SIZE }).catch(() => []);
    set((s) => ({ groups: { ...s.groups, [COMPANY_WORKSPACE_ID]: { items: first, exhausted: first.length < PAGE_SIZE, loaded: true } } }));
  },

  expandGroup: async (workspaceId) => {
    const g = get().groups[workspaceId];
    if (g?.loaded) return;
    const items = await listConversations(false, { workspaceId, limit: PAGE_SIZE }).catch(() => []);
    set((s) => ({ groups: { ...s.groups, [workspaceId]: { items, exhausted: items.length < PAGE_SIZE, loaded: true } } }));
  },

  loadMore: async (workspaceId) => {
    const g = get().groups[workspaceId];
    if (!g) return;
    const more = await listConversations(false, { workspaceId, limit: PAGE_SIZE, offset: g.items.length }).catch(() => []);
    // 按 id 合并去重（touch 后 offset 边界可能重）
    const seen = new Set(g.items.map((c) => c.id));
    const merged = [...g.items, ...more.filter((c) => !seen.has(c.id))].sort(byUpdatedDesc);
    set((s) => ({ groups: { ...s.groups, [workspaceId]: { items: merged, exhausted: more.length < PAGE_SIZE, loaded: true } } }));
  },

  setQuery: async (q) => {
    const query = q.trim();
    set({ query });
    if (!query) {
      set({ searchAll: null }); // 回分页态
      return;
    }
    // 搜索态：全量拉（只拉一次并发——以最后一次 query 为准丢弃过期响应）
    const all = await listConversations().catch(() => null);
    if (all && get().query === query) set({ searchAll: all });
  },

  refreshConversations: async () => {
    // 只刷新已展开组的第一页（保持简单：不追 offset 深页刷新）
    const s = get();
    if (s.query) {
      const all = await listConversations().catch(() => null);
      if (all) set({ searchAll: all });
      return;
    }
    const entries = await Promise.all(
      Object.entries(s.groups)
        .filter(([, g]) => g.loaded)
        .map(async ([wsId, g]) => {
          const items = await listConversations(false, { workspaceId: wsId, limit: Math.max(g.items.length, PAGE_SIZE) }).catch(() => g.items);
          return [wsId, { items, exhausted: items.length < Math.max(g.items.length, PAGE_SIZE), loaded: true }] as const;
        }),
    );
    set({ groups: Object.fromEntries(entries) });
  },

  refreshArchived: async () => {
    const convs = await listConversations(true).catch(() => null);
    if (convs) set({ archivedConversations: convs });
  },

  prependConversation: (c) => {
    set((s) => {
      const g = s.groups[c.workspaceId];
      const groups = g
        ? { ...s.groups, [c.workspaceId]: { ...g, items: [c, ...without(g.items, c.id)].sort(byUpdatedDesc), loaded: true } }
        : s.groups; // 未展开组不建条目（展开时懒加载会带上它）
      // ws 活跃度 = 新会话 updatedAt（置顶候选）
      const workspaces = sortWorkspaces(s.workspaces.map((w) => (w.id === c.workspaceId ? { ...w, lastActiveAt: c.updatedAt } : w)));
      return { groups, workspaces };
    });
  },

  archive: async (id) => {
    const prevGroups = get().groups;
    set((s) => {
      const groups = { ...s.groups };
      for (const [wsId, g] of Object.entries(groups)) groups[wsId] = { ...g, items: without(g.items, id) };
      return { groups };
    }); // 乐观下架（所有组）
    try {
      const row = await archiveConversation(id);
      set({ archivedConversations: [row, ...without(get().archivedConversations, id)] });
    } catch {
      set({ groups: prevGroups }); // 失败回滚
    }
  },

  restore: async (id) => {
    const prevArchived = get().archivedConversations;
    set({ archivedConversations: without(prevArchived, id) });
    try {
      await restoreConversation(id);
      await get().refreshConversations(); // 已展开组补真值
    } catch {
      set({ archivedConversations: prevArchived });
    }
  },

  remove: async (id) => {
    try {
      await deleteConversation(id);
    } finally {
      set((s) => {
        const groups = { ...s.groups };
        for (const [wsId, g] of Object.entries(groups)) groups[wsId] = { ...g, items: without(g.items, id) };
        return { groups, archivedConversations: without(get().archivedConversations, id) };
      });
    }
  },
}));
