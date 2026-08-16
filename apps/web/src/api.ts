// 后端 HTTP/SSE 封装（ticket #13 事件驱动）。dev 经 Vite proxy（同源）；prod 经反代。
// f2：apiFetch 统一 token 注入 + 401 拦截（onUnauthorized 回调→auth store 注册，避免 api↔store 循环依赖）。
import { parseSSEFrames, type Block, type SSEEvent } from "./sse";
import { getToken } from "./lib/token";

// Vite 注入（VITE_DEV_TOKEN 来自 AGENTANY_DEV_TOKEN）；未设则 undefined（dev 放行）。
// token 优先级：登录 token > 构建期 DEV_TOKEN（e2e/无登录环境兜底）。
const DEV_TOKEN = (import.meta.env.VITE_DEV_TOKEN as string | undefined) ?? "";

// 401 回调（auth store 启动时注册 forceLogout——api 层不 import store，防循环依赖）
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: () => void): void {
  onUnauthorized = fn;
}

/**
 * 统一 fetch：自动 Bearer（token ?? DEV_TOKEN）；401 且非 login 请求 → 401 回调 + throw。
 * login 自身 401 是正常业务结果（错密码），由调用方内联处理——不走拦截。
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken() ?? DEV_TOKEN;
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const r = await fetch(path, { ...init, headers });
  if (r.status === 401 && !path.startsWith("/auth/login")) {
    onUnauthorized?.();
    throw new Error(`unauthorized: ${path}`);
  }
  return r;
}

export interface Conversation {
  id: string; workspaceId: string; title: string | null; createdAt: string;
}
// ConversationRow（GET /conversations 列表形状，含 updatedAt——f1 端点）。
// userId 可选：乐观 prepend（createConversation 响应无此字段，refresh 兜底补真值）。
// #21：archivedAt 可选（旧后端无此列；null/缺省=活跃）。
export interface ConversationRow {
  id: string; workspaceId: string; userId?: string; title: string | null; createdAt: string; updatedAt: string; archivedAt?: string | null;
}
// Workspace（GET /workspaces 形状——toWorkspace；member=allUsers∪名单，admin=全部）
export interface Workspace {
  id: string; slug: string; name: string; allUsers: boolean; createdAt: string; updatedAt: string;
  archivedAt?: string | null; // #手风琴：管理页 switch 状态（默认列表已滤掉归档）
  lastActiveAt?: string | null; // #手风琴：侧栏排序锚（我的会话 max updatedAt；无会话 null→用 updatedAt 兜底）
  conversationCount?: number; // #手风琴：我的活跃会话数
}
// GET /conversations/:id/messages（#20 双源：pi session 优先、DB 兜底）统一 HistoryMessage 形状
export interface Message {
  id: number | string; // pi session entry id（string）或 DB 自增（兜底源）
  role: "user" | "assistant";
  content: string; // text blocks 拼接（冗余字段——前端不渲染，#20 比对用）
  blocks: Block[];
  createdAt: string;
}

// HITL 提问（ticket #16 ask_user + #18 审批门）：ask 卡（kind=ask）+ 审批卡（kind=approval）。
export interface Question {
  id: number; conversationId: string; runId: string | null; // approval 卡通过前无 run → null
  kind: "ask" | "approval"; workflowId: string | null; input: unknown;
  prompt: string; options: string[]; resumeSchema?: unknown; multiple: number;
  status: "pending" | "answered"; answer?: unknown; decidedBy: string | null;
  createdAt: string; answeredAt: string | null;
}

const jsonHeaders = { "Content-Type": "application/json" };

export async function createConversation(title?: string, workspaceId?: string): Promise<Conversation> {
  // workspaceId 缺省=公司 ws（ADR-0018）；#手风琴：组头 + 按钮传目标 ws
  const r = await apiFetch("/conversations", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ title, workspaceId }) });
  if (!r.ok) throw new Error(`createConversation: ${r.status}`);
  return r.json();
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  const r = await apiFetch(`/conversations/${conversationId}/messages`);
  if (!r.ok) throw new Error(`getMessages: ${r.status}`);
  return r.json();
}

// 会话列表（f1 端点）：创建者私有，updatedAt 倒序。可选 workspaceId 过滤（f2 前端全量取+本地分组）。
// #21：archived=true 取归档列表（默认活跃）。
// #手风琴：opts.limit/opts.workspaceId 分页拉取（侧栏每组懒加载）；无参全量（搜索兜底）。
export async function listConversations(archived = false, opts?: { workspaceId?: string; limit?: number; offset?: number }): Promise<ConversationRow[]> {
  const q = new URLSearchParams();
  if (archived) q.set("archived", "1");
  if (opts?.workspaceId) q.set("workspaceId", opts.workspaceId);
  if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) q.set("offset", String(opts.offset));
  const qs = q.toString();
  const r = await apiFetch(`/conversations${qs ? `?${qs}` : ""}`);
  if (!r.ok) throw new Error(`listConversations: ${r.status}`);
  return r.json();
}

// #21/ADR-0020：归档（可逆软态）/恢复。删除 admin-only 见 deleteConversation。
export async function archiveConversation(id: string): Promise<ConversationRow> {
  const r = await apiFetch(`/conversations/${id}/archive`, { method: "PATCH" });
  if (!r.ok) throw new Error(`archiveConversation: ${r.status}`);
  return r.json();
}

export async function restoreConversation(id: string): Promise<ConversationRow> {
  const r = await apiFetch(`/conversations/${id}/restore`, { method: "PATCH" });
  if (!r.ok) throw new Error(`restoreConversation: ${r.status}`);
  return r.json();
}

export async function deleteConversation(id: string): Promise<void> {
  const r = await apiFetch(`/conversations/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`deleteConversation: ${r.status}`);
}

// 我的 workspace 列表（allUsers∪名单；admin=全部）。
export async function listWorkspaces(): Promise<Workspace[]> {
  const r = await apiFetch("/workspaces");
  if (!r.ok) throw new Error(`listWorkspaces: ${r.status}`);
  return r.json();
}

export async function getHitlQuestions(conversationId: string): Promise<Question[]> {
  const r = await apiFetch(`/conversations/${conversationId}/hitl`);
  if (!r.ok) throw new Error(`getHitlQuestions: ${r.status}`);
  return r.json();
}

export async function abortConversation(conversationId: string): Promise<void> {
  await apiFetch(`/conversations/${conversationId}/abort`, { method: "POST" });
}


/**
 * 发消息：POST → 202 ACK（不再返流）。流式输出经 openStream 订阅的持久流异步到达。
 * 返回 202 / 429 / false（网络/其它错）。
 */
export async function postMessage(conversationId: string, content: string, inReplyTo?: number): Promise<number | false> {
  try {
    const r = await apiFetch(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(inReplyTo === undefined ? { content } : { content, inReplyTo }),
    });
    if (r.status === 202 || r.status === 429) return r.status;
    return false;
  } catch {
    return false;
  }
}

/**
 * 持久流（长连）：GET /stream，fetch+ReadableStream 消费，每个解析出的事件回调 onEvent。
 * signal 取消即关流（切会话/卸载时）。重连期丢帧是已知缺口（#19+/序列号再补）。
 */
export async function openStream(conversationId: string, onEvent: (e: SSEEvent) => void, signal?: AbortSignal): Promise<void> {
  const r = await apiFetch(`/conversations/${conversationId}/stream`, { signal });
  if (!r.ok) throw new Error(`openStream: ${r.status}`);
  if (!r.body) throw new Error("no response body");
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parsed = parseSSEFrames(buf);
    buf = parsed.rest;
    for (const e of parsed.events) onEvent(e);
  }
}
