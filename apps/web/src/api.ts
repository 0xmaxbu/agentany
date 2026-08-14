// 后端 HTTP/SSE 封装（ticket #13 事件驱动）。dev 经 Vite proxy（同源）；prod 经反代。dev-token（若设）→ Bearer。
import { parseSSEFrames, type SSEEvent } from "./sse";

// Vite 注入（VITE_DEV_TOKEN 来自 AGENTANY_DEV_TOKEN）；未设则 undefined（dev 放行）。
const DEV_TOKEN = (import.meta.env.VITE_DEV_TOKEN as string | undefined) ?? "";

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (DEV_TOKEN) h["Authorization"] = `Bearer ${DEV_TOKEN}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

export interface Conversation {
  id: string; workspaceId: string; title: string | null; createdAt: string;
}
export interface Message {
  id: number; conversationId: string; role: "user" | "assistant"; content: string; createdAt: string;
}

// HITL 提问（ticket #16 ask_user + #18 审批门）：ask 卡（kind=ask）+ 审批卡（kind=approval）。
export interface Question {
  id: number; conversationId: string; runId: string | null; // approval 卡通过前无 run → null
  kind: "ask" | "approval"; workflowId: string | null; input: unknown;
  prompt: string; options: string[]; resumeSchema?: unknown; multiple: number;
  status: "pending" | "answered"; answer?: unknown; decidedBy: string | null;
  createdAt: string; answeredAt: string | null;
}

export async function createConversation(title?: string): Promise<Conversation> {
  const r = await fetch("/conversations", { method: "POST", headers: headers(true), body: JSON.stringify({ title }) }); // 缺省 workspaceId=公司 ws（ADR-0018）
  if (!r.ok) throw new Error(`createConversation: ${r.status}`);
  return r.json();
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  const r = await fetch(`/conversations/${conversationId}/messages`, { headers: headers() });
  if (!r.ok) throw new Error(`getMessages: ${r.status}`);
  return r.json();
}

export async function getHitlQuestions(conversationId: string): Promise<Question[]> {
  const r = await fetch(`/conversations/${conversationId}/hitl`, { headers: headers() });
  if (!r.ok) throw new Error(`getHitlQuestions: ${r.status}`);
  return r.json();
}

export async function abortConversation(conversationId: string): Promise<void> {
  await fetch(`/conversations/${conversationId}/abort`, { method: "POST", headers: headers() });
}

// #18 审批门：人类审批某 pending 审批卡。POST /approvals/:id/decide（main app, authStub）。
// 返 200（已决，hitl_answered 帧经持久流驱动 UI）/ 409（已决并发）/ 其它。
export async function decideApproval(questionId: number, decision: "approve" | "deny"): Promise<number> {
  const r = await fetch(`/approvals/${questionId}/decide`, { method: "POST", headers: headers(true), body: JSON.stringify({ decision }) });
  return r.status;
}

/**
 * 发消息：POST → 202 ACK（不再返流）。流式输出经 openStream 订阅的持久流异步到达。
 * 返回 202 / 429 / false（网络/其它错）。
 */
export async function postMessage(conversationId: string, content: string): Promise<number | false> {
  try {
    const r = await fetch(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ content }),
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
  const r = await fetch(`/conversations/${conversationId}/stream`, { headers: headers(), signal });
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
