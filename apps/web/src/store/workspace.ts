// workspace store（f2 拆分②）：ws 列表 + 会话列表（f1 端点）+ 分组视图。
// 会话列表职责从 chat store 迁此（弃 localStorage——服务端为真相，URL 锚当前会话）。
import { create } from "zustand";
import { listConversations, listWorkspaces, type ConversationRow, type Workspace } from "../api";

interface WorkspaceState {
  workspaces: Workspace[];
  conversations: ConversationRow[]; // updatedAt 倒序（后端排好，前端不动序）
  loaded: boolean;
  load: () => Promise<void>; // 并行拉 ws + 会话（首载）
  refreshConversations: () => Promise<void>; // 新建/发消息后（touch 变 updatedAt 顺序）
  /** 建会话后本地 prepend（乐观——新会话立即上列表顶部，不等 refresh）。 */
  prependConversation: (c: ConversationRow) => void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  conversations: [],
  loaded: false,

  load: async () => {
    const [wss, convs] = await Promise.all([listWorkspaces().catch(() => []), listConversations().catch(() => [])]);
    set({ workspaces: wss, conversations: convs, loaded: true });
  },

  refreshConversations: async () => {
    const convs = await listConversations().catch(() => null);
    if (convs) set({ conversations: convs });
  },

  prependConversation: (c) => {
    set({ conversations: [c, ...get().conversations.filter((x) => x.id !== c.id)] });
  },
}));
