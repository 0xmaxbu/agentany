// chat 状态（借鉴 #17 Zustand）。切片②（ticket #13）：事件驱动——POST /messages=202，输出经持久流异步到。
// 单一真相 = 持久流：user_message/delta/done 帧驱动 UI；会话历史从 GET /messages 加载。
// 会话列表客户端 localStorage 跟踪（后端无"列会话"端点；slice① 单用户够用）。
import { create } from "zustand";
import { abortConversation, createConversation, decideApproval as decideApprovalApi, getHitlQuestions, getMessages, openStream, postMessage, type Question } from "./api";
import type { SSEEvent } from "./sse";
import type { Message } from "./api";

export interface UIMessage {
  id: number | null; // null = 流式中（done 后赋值）
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "complete" | "error" | "aborted";
}
export interface Convo {
  id: string;
  title: string | null;
  createdAt: string;
}
// ticket #14：工作流 run 进度（基础渲染）。
export interface UIRunStep {
  stepId: string;
  status: string;
}
export interface UIRun {
  runId: string;
  workflowId?: string;
  status: string; // running | suspended | completed | failed | resumed
  steps: UIRunStep[];
  note?: string;
}
// ticket #16 ask 卡 + #18 审批卡（pending 显卡 + 选项按钮；answered 显答案）。
export interface UIQuestion {
  id: number;
  runId: string | null; // approval 卡通过前无 run → null
  kind: "ask" | "approval";
  workflowId: string | null; // approval：待审批工作流
  prompt: string;
  options: string[];
  status: "pending" | "answered";
  answer?: unknown;
}

interface ChatState {
  conversationId: string | null;
  conversations: Convo[];
  messages: UIMessage[];
  sending: boolean;
  streamCtrl: AbortController | null; // 持久流生命周期（切会话/卸载时 abort）
  runs: UIRun[]; // 工作流 run 进度（持久流 run_*/step_* 驱动）
  questions: UIQuestion[]; // HITL 提问（持久流 hitl_* 驱动；刷新从 GET /hitl 恢复）
  init: () => Promise<void>;
  send: (content: string) => Promise<void>;
  stop: () => Promise<void>;
  newConversation: () => Promise<void>;
  switchConversation: (id: string) => Promise<void>;
  decideApproval: (questionId: number, decision: "approve" | "deny") => Promise<void>; // #18 审批门
}

// —— localStorage 持久化（当前会话 + 会话列表）——
const LS_KEY = "agentany.chat.v1";
interface SavedState {
  current: string | null;
  conversations: Convo[];
}
function loadState(): SavedState {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? "") as SavedState;
    return v && Array.isArray(v.conversations) ? v : { current: null, conversations: [] };
  } catch {
    return { current: null, conversations: [] };
  }
}
function saveState(s: ChatState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ current: s.conversationId, conversations: s.conversations }));
  } catch {
    /* 无 localStorage 忽略 */
  }
}

// init 并发去重（React StrictMode dev 双触发）。
let initPromise: Promise<void> | null = null;

const errMsg = (message: string): UIMessage => ({ id: null, role: "assistant", content: `⚠️ ${message}`, status: "error" });
const rollback = (messages: UIMessage[], message: string): UIMessage[] => messages.slice(0, -2).concat([errMsg(message)]);
const toUIMessage = (m: Message): UIMessage => ({ id: m.id, role: m.role, content: m.content, status: "complete" });
const toUIQuestion = (q: Question): UIQuestion => ({ id: q.id, runId: q.runId, kind: q.kind, workflowId: q.workflowId, prompt: q.prompt, options: q.options, status: q.status, answer: q.answer });
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const useChat = create<ChatState>((set, get) => {
  // 持久流帧 → UI 更新（单一真相）。
  const onFrame = (e: SSEEvent) => {
    const msgs = get().messages;
    if (e.type === "user_message") {
      set({ messages: [...msgs, { id: e.id, role: "user", content: e.content, status: "complete" }] });
    } else if (e.type === "delta") {
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.status === "streaming") {
        last.content += e.text; // 原地改
        set({ messages: [...msgs] }); // 浅拷触发订阅
      } else {
        set({ messages: [...msgs, { id: null, role: "assistant", content: e.text, status: "streaming" }] });
      }
    } else if (e.type === "done") {
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        last.id = e.messageId ?? last.id;
        last.status = e.aborted ? "aborted" : "complete";
        if (e.text != null) last.content = e.text;
        set({ messages: [...msgs], sending: false });
      } else {
        set({ sending: false });
      }
    } else if (e.type === "error") {
      set({ messages: rollback(msgs, e.message), sending: false });
    } else if (e.type === "run_started") {
      // 幂等：resume 会经 run() 再发一次 run_started（runner.ts:97+200）——runId 已在则更新状态、不新增卡。
      set((s) => {
        if (s.runs.some((r) => r.runId === e.runId)) {
          return { runs: s.runs.map((r) => (r.runId === e.runId ? { ...r, status: "running", workflowId: e.workflowId } : r)) };
        }
        return { runs: [...s.runs, { runId: e.runId, workflowId: e.workflowId, status: "running", steps: [] }] };
      });
    } else if (e.type === "hitl_request") {
      set((s) => ({ questions: [...s.questions, { id: e.questionId, runId: e.runId, kind: e.kind ?? "ask", workflowId: e.workflowId ?? null, prompt: e.prompt, options: e.options, status: "pending" }] }));
    } else if (e.type === "hitl_answered") {
      set((s) => ({ questions: s.questions.map((q) => (q.id === e.questionId ? { ...q, status: "answered", answer: e.answer, runId: e.runId ?? q.runId } : q)) }));
    } else if (e.type.startsWith("run_")) {
      const status = e.type.replace("run_", "");
      set((s) => ({ runs: s.runs.map((r) => (r.runId === e.runId ? { ...r, status, note: (e as { note?: string }).note ?? r.note } : r)) }));
    } else if (e.type === "step_started") {
      set((s) => ({ runs: s.runs.map((r) => (r.runId === e.runId ? { ...r, steps: [...r.steps, { stepId: e.stepId, status: "running" }] } : r)) }));
    } else if (e.type === "step_completed") {
      set((s) => ({ runs: s.runs.map((r) => (r.runId === e.runId ? { ...r, steps: [...r.steps, { stepId: e.stepId, status: e.status }] } : r)) }));
    }
  };

  const closeStream = () => {
    const ac = get().streamCtrl;
    if (ac) {
      ac.abort();
      set({ streamCtrl: null });
    }
  };
  const openStreamFor = (convId: string) => {
    closeStream();
    const ac = new AbortController();
    set({ streamCtrl: ac });
    openStream(convId, onFrame, ac.signal).catch((e) => {
      if (!ac.signal.aborted) set({ messages: [errMsg(msg(e))] });
    });
  };

  return {
    conversationId: null,
    conversations: [],
    messages: [],
    sending: false,
    streamCtrl: null,
    runs: [],
    questions: [],

    init: () => {
      if (get().conversationId) return Promise.resolve();
      if (!initPromise) {
        initPromise = (async () => {
          const saved = loadState();
          if (saved.current && saved.conversations.some((c) => c.id === saved.current)) {
            set({ conversationId: saved.current, conversations: saved.conversations });
            try {
              set({
                messages: (await getMessages(saved.current)).map(toUIMessage),
                questions: (await getHitlQuestions(saved.current)).map(toUIQuestion),
              });
            } catch (e) {
              set({ messages: [errMsg(msg(e))] });
            }
            openStreamFor(saved.current);
            return;
          }
          await get().newConversation();
          initPromise = null;
        })();
      }
      return initPromise;
    },

    newConversation: async () => {
      try {
        const conv = await createConversation();
        const conversations = [{ id: conv.id, title: conv.title, createdAt: conv.createdAt }, ...get().conversations];
        set({ conversationId: conv.id, conversations, messages: [], runs: [], questions: [] });
        saveState(get());
        openStreamFor(conv.id);
      } catch (e) {
        set({ messages: [errMsg(msg(e))] });
      }
    },

    switchConversation: async (id) => {
      if (get().sending || id === get().conversationId) return;
      set({ conversationId: id, messages: [], runs: [], questions: [] });
      saveState(get());
      try {
        set({
          messages: (await getMessages(id)).map(toUIMessage),
          questions: (await getHitlQuestions(id)).map(toUIQuestion),
        });
      } catch (e) {
        set({ messages: [errMsg(msg(e))] });
      }
      openStreamFor(id);
    },

    send: async (content) => {
      const convId = get().conversationId;
      if (!convId || get().sending) return;
      set({ sending: true });
      const status = await postMessage(convId, content);
      if (status === 429) {
        set((s) => ({ messages: [...s.messages, errMsg("conversation busy (queue full)")], sending: false }));
      } else if (status === false) {
        set((s) => ({ messages: [...s.messages, errMsg("send failed")], sending: false }));
      }
      // 202：user_message / delta / done 由持久流异步驱动 UI
    },

    stop: async () => {
      const convId = get().conversationId;
      if (convId) await abortConversation(convId); // 服务端杀 turn → done.aborted 经持久流回来
    },

    decideApproval: async (questionId, decision) => {
      try {
        const status = await decideApprovalApi(questionId, decision);
        if (status !== 200 && status !== 409) {
          set((s) => ({ messages: [...s.messages, errMsg(`审批失败 (${status})`)] }));
        }
        // 200：hitl_answered 帧经持久流驱动 UI；409：已决（并发双击），帧应已到。
      } catch (e) {
        set((s) => ({ messages: [...s.messages, errMsg(msg(e))] }));
      }
    },
  };
});
