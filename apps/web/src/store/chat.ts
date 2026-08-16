// chat 状态（借鉴 #17 Zustand）。切片②（ticket #13）：事件驱动——POST /messages=202，输出经持久流异步到。
// 单一真相 = 持久流：user_message/delta/done 帧驱动 UI；会话历史从 GET /messages 加载。
// f2-3：会话列表职责迁 workspace store（服务端真相，弃 localStorage）；URL /c/:id 为当前会话锚
//（ChatPage effect 唯一驱动 switchConversation/newConversation——init 已废）。
import { create } from "zustand";
import { abortConversation, createConversation, getConversationFiles, getHitlQuestions, getMessages, openStream, postMessage, type Conversation, type Question, type TaskFileGroup } from "../api";
import { useWorkspace, COMPANY_WORKSPACE_ID } from "./workspace";
import type { SSEEvent } from "../sse";
import type { Block } from "../sse";
import { BLOCK_FRAME, BLOCK_KIND, findToolUse, parseToolResultMeta, parseToolUseMeta } from "../lib/blocks";

// 渲染层块（f3/ADR-0019）：Block + 流式标记 + tool_use 折挂的 result + 组装期 blockId（SSE 帧定位用）。
export interface UIBlockBase {
  streaming?: boolean; // delta 未完（cursor 用）
  blockId?: string; // 组装期帧定位（block_start 的 id；渲染不消费）
}
export type UIAnyBlock =
  | ({ kind: "text"; text: string } & UIBlockBase)
  | ({ kind: "thinking"; text: string } & UIBlockBase)
  | ({ kind: "tool_use"; toolCallId: string; name: string; arguments: unknown; result?: { text: string; isError: boolean } } & UIBlockBase)
  | ({ kind: "tool_result"; toolCallId: string; toolName: string; text: string; isError: boolean } & UIBlockBase);

export interface UIMessage {
  id: number | null; // null = 流式中（done 后赋值）
  role: "user" | "assistant";
  blocks: UIAnyBlock[]; // f3：消息 = blocks 序列（ADR-0019 单一真相；旧 content string 已删）
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
  workspaceId: string | null; // 当前会话挂的 ws（#30 文件预览路由锚）
  messages: UIMessage[];
  sending: boolean;
  streamCtrl: AbortController | null; // 持久流生命周期（切会话/卸载时 abort）
  runs: UIRun[]; // 工作流 run 进度（持久流 run_*/step_* 驱动）
  questions: UIQuestion[]; // HITL 提问（持久流 hitl_* 驱动；刷新从 GET /hitl 恢复）
  fileGroups: TaskFileGroup[]; // #30 产出文件（按 run 分组；outputMessageId 锚到产出消息尾；done 帧后重拉）
  send: (content: string) => Promise<void>;
  /** 持久流帧 → 状态（导出供单测直推帧；openStream 内部用同一函数）。 */
  onFrame: (e: SSEEvent) => void;
  stop: () => Promise<void>;
  newConversation: (workspaceId?: string) => Promise<string | null>; // 返新会话 id（ChatPage navigate 用；#手风琴：可指定 ws）
  switchConversation: (id: string) => Promise<void>; // 幂等（同 id return）
  closeStream: () => void; // 断持久流（登出/forceLogout 时 auth store 调）
  sendCardAnswer: (questionId: number, content: string) => Promise<void>; // 统一卡应答（消息绑定 questionId；task/approval/ask 三卡同路）
  refreshFiles: (conversationId: string) => Promise<void>; // #30：拉产出文件分组（进会话/任务 turn done 后调；无文件静默空）
}

const errMsg = (message: string): UIMessage => ({ id: null, role: "assistant", blocks: [{ kind: "text", text: message }], status: "error" });
const rollback = (messages: UIMessage[], message: string): UIMessage[] => messages.slice(0, -2).concat([errMsg(message)]);
// 历史（GET messages HistoryMessage 形状）→ UIMessage：blocks 直通（tool_result 折进 tool_use 卡——同实时归属规则）
const foldToolResults = (blocks: UIAnyBlock[]): UIAnyBlock[] => {
  const out: UIAnyBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "tool_result") {
      const host = [...out].reverse().find((x) => x.kind === "tool_use" && x.toolCallId === b.toolCallId);
      if (host && host.kind === "tool_use") host.result = { text: b.text, isError: b.isError };
      else console.warn("[blocks] orphan tool_result in history:", b.toolCallId);
      continue;
    }
    out.push({ ...b });
  }
  return out;
};
const toUIMessage = (m: { id: string | number; dbId?: number | null; role: "user" | "assistant"; blocks: Block[]; status?: string }): UIMessage => ({
  id: m.dbId ?? null, // #34 反馈锚只认 dbId（pi 源=对齐回填；DB 兜底源=自带；无=不可反馈）
  role: m.role,
  blocks: foldToolResults(m.blocks),
  status: "complete",
});
const toUIQuestion = (q: Question): UIQuestion => ({ id: q.id, runId: q.runId, kind: q.kind, workflowId: q.workflowId, prompt: q.prompt, options: q.options, status: q.status, answer: q.answer });
import { msg } from "../lib/msg";
// 建会话并发去重（模块级，同旧 store initPromise 模式）：React StrictMode dev 双触发复用同一 promise
let creatingInflight: Promise<string | null> | null = null;

/**
 * block 三帧组装状态机（f3/ADR-0019，纯函数供单测）：
 * - 隐式跟随：block_start 且当前无 streaming assistant 消息 → 自动开新 assistant 消息（pi 一 turn 一消息）
 * - tool_result 不占块位：按 toolCallId 折进 tool_use 块的 result 字段（**全消息列表**找 owner——可跨消息归属）
 * - 孤儿帧（无宿主的 delta/end/tool_result）→ 丢弃 + console.warn（丢帧是 #19 重连债务，不在渲染层补救）；
 *   回撤只撤销**本次自开**的宿主消息，绝不删已有 streaming 消息。
 * kind/帧 type 判断统一引用 lib/blocks 常量（防字面量漂移）。
 */
const onBlockFrame = (msgs: UIMessage[], e: SSEEvent): UIMessage[] => {
  if (e.type !== BLOCK_FRAME.start && e.type !== BLOCK_FRAME.delta && e.type !== BLOCK_FRAME.end) return msgs;
  // 定位宿主消息：末条 streaming 中的 assistant（隐式跟随——非 streaming 则 block_start 自开新消息）
  let host = msgs[msgs.length - 1];
  let opened = false; // 本次帧是否自开了 host（孤儿回撤只撤销自己造成的副作用）
  if (!host || host.role !== "assistant" || host.status !== "streaming") {
    if (e.type !== BLOCK_FRAME.start) {
      console.warn("[blocks] orphan frame (no streaming message):", e.type, (e as { blockId?: string }).blockId);
      return msgs;
    }
    host = { id: null, role: "assistant", blocks: [], status: "streaming" };
    opened = true;
    msgs = [...msgs, host];
  }
  const blocks = host.blocks;
  const findOpen = (id: string) => blocks.find((b) => (b as { blockId?: string }).blockId === id);

  if (e.type === BLOCK_FRAME.start) {
    if (e.kind === BLOCK_KIND.toolUse) {
      const m = parseToolUseMeta(e.meta);
      blocks.push({ kind: BLOCK_KIND.toolUse, blockId: e.blockId, toolCallId: m.toolCallId ?? e.blockId, name: m.name ?? "", arguments: m.arguments ?? {} });
    } else if (e.kind === BLOCK_KIND.toolResult) {
      const m = parseToolResultMeta(e.meta);
      // 折进宿主 tool_use（按 toolCallId **全消息列表**找——可跨消息；无宿主 → 丢弃不建块）
      const owner = findToolUse(msgs, m.toolCallId ?? "");
      if (owner) {
        // 挂占位 result 块（记 blockId 供后续 delta 追加；end 时折进 owner 后移除）
        blocks.push({ kind: BLOCK_KIND.toolResult, blockId: e.blockId, toolCallId: m.toolCallId ?? "", toolName: m.toolName ?? "", text: "", isError: m.isError === true });
        return [...msgs];
      }
      console.warn("[blocks] orphan tool_result (tool_use not found):", m.toolCallId);
      return opened ? msgs.filter((x) => x !== host) : msgs; // 只撤销本次自开的宿主
    } else {
      blocks.push({ kind: e.kind, blockId: e.blockId, text: "", streaming: true } as UIAnyBlock);
    }
    return [...msgs];
  }

  const target = findOpen(e.blockId);
  if (!target) {
    console.warn("[blocks] orphan frame (block not open):", e.type, e.blockId);
    return msgs;
  }
  if (e.type === BLOCK_FRAME.delta) {
    if (target.kind === BLOCK_KIND.text || target.kind === BLOCK_KIND.thinking || target.kind === BLOCK_KIND.toolResult) target.text += e.delta;
    // tool_use 无 delta（start 即完整）
  } else {
    // block_end：关流式标记（blockId 保留——作 React key 稳定标识，见 MessageBlock blockKey）
    if (target.kind === BLOCK_KIND.text || target.kind === BLOCK_KIND.thinking) delete target.streaming;
    if (target.kind === BLOCK_KIND.toolResult) {
      // 归宿：折进 tool_use 的 result 字段（全消息列表找 owner——与 start 对称，跨消息归属）；
      // 自身从所在消息块位移除（owner 可能在别的消息）
      const owner = findToolUse(msgs, target.toolCallId);
      if (owner) {
        owner.block.result = { text: target.text, isError: target.isError };
        host.blocks = blocks.filter((b) => b !== target);
      } else {
        console.warn("[blocks] orphan tool_result end (owner vanished):", target.toolCallId);
        host.blocks = blocks.filter((b) => b !== target); // 丢弃（可观测）
      }
    }
  }
  return [...msgs];
};

export const useChat = create<ChatState>((set, get) => {
  // 持久流帧 → UI 更新（单一真相）。f3/ADR-0019：block 三帧组装（隐式跟随开新消息、孤儿丢弃+warn）。
  const onFrame = (e: SSEEvent) => {
    const msgs = get().messages;
    if (e.type === "user_message") {
      set({ messages: [...msgs, { id: e.id, role: "user", blocks: [{ kind: "text", text: e.content }], status: "complete" }] });
    } else if (e.type === "block_start" || e.type === "block_delta" || e.type === "block_end") {
      set({ messages: onBlockFrame(msgs, e) });
    } else if (e.type === "done") {
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        last.id = e.messageId ?? last.id;
        last.status = e.aborted ? "aborted" : "complete";
        // done 不带全文（ADR-0019）：blocks 流是真相，丢帧属 SSE 重连债务不在渲染层补救
        set({ messages: [...msgs], sending: false });
      } else {
        set({ sending: false });
      }
      // #30：任务 turn 收口后产出文件才登记完（executeTask 在 drained 后写 task_files）——重拉分组
      const convId = get().conversationId;
      if (convId) void refreshFiles(convId);
    } else if (e.type === "error") {
      set({ messages: rollback(msgs, e.message), sending: false });
    } else if (e.type === "title") {
      const convId = get().conversationId;
      if (convId) useWorkspace.getState().applyTitle(convId, e.title); // #命名：侧栏即时换名
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
    } else if (e.type === "run_resumed" || e.type === "run_completed" || e.type === "run_suspended" || e.type === "run_failed") {
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

  // #30 产出文件：拉分组（产出会话才有数据；普通会话 200 空数组——静默）。
  const refreshFiles = async (convId: string) => {
    try {
      const groups = await getConversationFiles(convId);
      if (get().conversationId === convId) set({ fileGroups: groups }); // 竞态守卫：切走了不写
    } catch {
      /* 静默：文件列表失败不阻塞对话（列表卡空态即可） */
    }
  };

  return {
    conversationId: null,
    workspaceId: null,
    messages: [],
    sending: false,
    streamCtrl: null,
    runs: [],
    questions: [],
    fileGroups: [],

    onFrame,

    newConversation: async (workspaceId?: string) => {
      // StrictMode dev 双触发（ChatPage index effect 双跑）去重：进行中的建会话复用同一 promise
      if (creatingInflight) return creatingInflight;
      creatingInflight = (async () => {
        try {
          const conv: Conversation = await createConversation(undefined, workspaceId); // #手风琴：缺省公司 ws
          useWorkspace.getState().prependConversation({ ...conv, updatedAt: new Date().toISOString() }); // 乐观 prepend（refresh 兜底校正）
          set({ conversationId: conv.id, workspaceId: conv.workspaceId, messages: [], runs: [], questions: [], fileGroups: [] });
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
      // #30：从会话列表反查该会话的 ws（挂任务同 ws——文件预览路由锚）；查不到兜底公司 ws
      const wsId = Object.values(useWorkspace.getState().groups)
        .flatMap((g) => g.items)
        .find((c) => c.id === id)?.workspaceId ?? COMPANY_WORKSPACE_ID;
      set({ conversationId: id, workspaceId: wsId, messages: [], runs: [], questions: [], fileGroups: [] });
      try {
        set({
          messages: (await getMessages(id)).map(toUIMessage),
          questions: (await getHitlQuestions(id)).map(toUIQuestion),
        });
      } catch (e) {
        set({ messages: [errMsg(msg(e))] });
      }
      void refreshFiles(id); // #30：产出会话历史文件（非阻塞——历史先出）
      openStreamFor(id);
    },

    closeStream,

    refreshFiles,

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

    sendCardAnswer: async (questionId, content) => {
      // 统一卡应答：答案=普通消息（对话历史可见）+ inReplyTo 绑定卡——服务端确定性收口（零 LLM 二跳）。
      const convId = get().conversationId;
      if (!convId) return;
      const status = await postMessage(convId, content, questionId);
      if (status === false) set((s) => ({ messages: [...s.messages, errMsg("发送失败")] }));
      // 202：hitl_answered 帧经持久流驱动卡转已答；非 pending 重复点=服务端幂等 no-op。
    },
  };
});
