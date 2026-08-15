// workspace store（f2 拆分②）：ws 列表 + 会话列表（f1 端点）+ 分组视图。
// 会话列表职责从 chat store 迁此（弃 localStorage——服务端为真相，URL 锚当前会话）。
// #21/ADR-0020：archivedConversations 归档列表 + archive/restore/remove 三个动作。
import { create } from "zustand";
import { archiveConversation, deleteConversation, listConversations, listWorkspaces, restoreConversation, type ConversationRow, type Workspace } from "../api";

interface WorkspaceState {
  workspaces: Workspace[];
  conversations: ConversationRow[]; // updatedAt 倒序（后端排好，前端不动序）
  archivedConversations: ConversationRow[]; // #21 归档区（侧栏折叠入口展开）
  loaded: boolean;
  load: () => Promise<void>; // 并行拉 ws + 会话（首载）
  refreshConversations: () => Promise<void>; // 新建/发消息后（touch 变 updatedAt 顺序）
  refreshArchived: () => Promise<void>; // 归档区展开时按需拉
  /** 建会话后本地 prepend（乐观——新会话立即上列表顶部，不等 refresh）。 */
  prependConversation: (c: ConversationRow) => void;
  /** #21 归档：本地即时下架 + 落库（失败回滚）。 */
  archive: (id: string) => Promise<void>;
  /** #21 恢复：本地即时移出归档区 + 主列表 refresh 补真值（失败回滚）。 */
  restore: (id: string) => Promise<void>;
  /** #21 admin 硬删：后端全链清理；本地三处移除。 */
  remove: (id: string) => Promise<void>;
}

const without = (arr: ConversationRow[], id: string) => arr.filter((c) => c.id !== id);

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  conversations: [],
  archivedConversations: [],
  loaded: false,

  load: async () => {
    const [wss, convs] = await Promise.all([listWorkspaces().catch(() => []), listConversations().catch(() => [])]);
    set({ workspaces: wss, conversations: convs, loaded: true });
  },

  refreshConversations: async () => {
    const convs = await listConversations().catch(() => null);
    if (convs) set({ conversations: convs });
  },

  refreshArchived: async () => {
    const convs = await listConversations(true).catch(() => null);
    if (convs) set({ archivedConversations: convs });
  },

  prependConversation: (c) => {
    set({ conversations: [c, ...without(get().conversations, c.id)] });
  },

  archive: async (id) => {
    const prev = get().conversations;
    set({ conversations: without(prev, id) }); // 乐观下架
    try {
      const row = await archiveConversation(id);
      set({ archivedConversations: [row, ...without(get().archivedConversations, id)] });
    } catch {
      set({ conversations: prev }); // 失败回滚
    }
  },

  restore: async (id) => {
    const prevArchived = get().archivedConversations;
    set({ archivedConversations: without(prevArchived, id) }); // 乐观移出归档区
    try {
      await restoreConversation(id);
      await get().refreshConversations(); // 主列表补真值（updatedAt 顺序后端定）
    } catch {
      set({ archivedConversations: prevArchived });
    }
  },

  remove: async (id) => {
    try {
      await deleteConversation(id);
    } finally {
      // 无论成败先移出 UI（失败保留会让重试撞 404 困惑；列表 refresh 兜底校正）
      set({ conversations: without(get().conversations, id), archivedConversations: without(get().archivedConversations, id) });
    }
  },
}));
