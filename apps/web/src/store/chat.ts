// chat 状态（借鉴 #17 Zustand）。切片②（ticket #13）：事件驱动——POST /messages=202，输出经持久流异步到。
// 单一真相 = 持久流：user_message/delta/done 帧驱动 UI；会话历史从 GET /messages 加载。
// f2-3：会话列表职责迁 workspace store（服务端真相，弃 localStorage）；URL /c/:id 为当前会话锚
//（ChatPage effect 唯一驱动 switchConversation/newConversation——init 已废）。
import { create } from "zustand";
import { abortConversation, createConversation, decideApproval as decideApprovalApi, getHitlQuestions, getMessages, openStream, postMessage, type Conversation, type Question } from "../api";
import { useWorkspace } from "./workspace";
import type { SSEEvent } from "../sse";
import type { Message } from "../api";

export interface UIMessage {
  id: number | null; // null = 流式中（done 后赋值）
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "complete" | "error" | "aborted";
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
  messages: UIMessage[];
  sending: boolean;
  streamCtrl: AbortController | null; // 持久流生命周期（切会话/卸载时 abort）
  runs: UIRun[]; // 工作流 run 进度（持久流 run_*/step_* 驱动）
  questions: UIQuestion[]; // HITL 提问（持久流 hitl_* 驱动；刷新从 GET /hitl 恢复）
  send: (content: string) => Promise<void>;
  stop: () => Promise<void>;
  newConversation: () => Promise<string | null>; // 返新会话 id（ChatPage navigate 用）
  switchConversation: (id: string) => Promise<void>; // 幂等（同 id return）
  closeStream: () => void; // 断持久流（登出/forceLogout 时 auth store 调）
  decideApproval: (questionId: number, decision: "approve" | "deny") => Promise<void>; // #18 审批门
}

const errMsg = (message: string): UIMessage => ({ id: null, role: "assistant", content: `⚠️ ${message}`, status: "error" });
const rollback = (messages: UIMessage[], message: string): UIMessage[] => messages.slice(0, -2).concat([errMsg(message)]);
const toUIMessage = (m: Message): UIMessage => ({ id: m.id, role: m.role, content: m.content, status: "complete" });
const toUIQuestion = (q: Question): UIQuestion => ({ id: q.id, runId: q.runId, kind: q.kind, workflowId: q.workflowId, prompt: q.prompt, options: q.options, status: q.status, answer: q.answer });
import { msg } from "../lib/msg";
// 建会话并发去重（模块级，同旧 store initPromise 模式）：React StrictMode dev 双触发复用同一 promise
let creatingInflight: Promise<string | null> | null = null;

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
    messages: [],
    sending: false,
    streamCtrl: null,
    runs: [],
    questions: [],

    newConversation: async () => {
      // StrictMode dev 双触发（ChatPage index effect 双跑）去重：进行中的建会话复用同一 promise
      if (creatingInflight) return creatingInflight;
      creatingInflight = (async () => {
        try {
          const conv: Conversation = await createConversation();
          useWorkspace.getState().prependConversation({ ...conv, updatedAt: new Date().toISOString() }); // 乐观 prepend（refresh 兜底校正）
          set({ conversationId: conv.id, messages: [], runs: [], questions: [] });
          openStreamFor(conv.id);
          void useWorkspace.getState().refreshConversations();
          return conv.id;
        } catch (e) {
          set({ messages: [errMsg(msg(e))] });
          return null;
        } finally {
          creatingInflight = null;
        }
      })();
      return creatingInflight;
    },

    switchConversation: async (id) => {
      if (get().sending || id === get().conversationId) return;
      set({ conversationId: id, messages: [], runs: [], questions: [] });
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

    closeStream,

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
      // 202：user_message / delta / done 由持久流异步驱动 UI；touch 变列表序 → 刷新侧栏
      if (status === 202) void useWorkspace.getState().refreshConversations();
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
