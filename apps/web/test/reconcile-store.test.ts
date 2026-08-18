// T5（#54）：断流重连对账的 store 装配——reconcile 拉三快照与 live 幂等合并。
// seam：mock.module 桩 api（同 runs-restore），驱动真 store 的 reconcile action。
import { describe, test, expect, beforeEach, mock } from "bun:test";

const unused = () => { throw new Error("api stub: not used in reconcile-store test"); };

mock.module("../src/api", () => ({
  setOnUnauthorized: () => {},
  apiFetch: unused,
  createConversation: unused,
  listConversations: async () => [],
  archiveConversation: unused,
  restoreConversation: unused,
  deleteConversation: unused,
  listWorkspaces: async () => [],
  rateMessage: unused, getMessageFeedback: unused, rateRun: unused, getRunFeedback: unused, fetchFile: unused,
  listScheduledTasks: async () => [], listTaskRuns: async () => [],
  runTaskNow: unused, setTaskEnabled: unused, deleteTask: unused, markTaskViewed: unused,
  createSystemTask: unused, updateTask: unused, abortConversation: async () => {}, postMessage: unused,
  DISTILL_TASK_ID: "", isDistillSeed: () => false,
  openStream: async () => {},
  // 快照桩：断流期间发生的变化（新消息 / 卡已答 / run 完成）在重连后被快照带出
  getMessages: async () => [
    { id: "s1", dbId: 1, role: "user", blocks: [{ kind: "text", text: "重连前的消息" }] },
    { id: "s2", dbId: 2, role: "assistant", blocks: [{ kind: "text", text: "断流期间的回复" }] },
  ],
  getHitlQuestions: async () => [
    { id: 7, runId: null, kind: "ask", workflowId: null, prompt: "断流期间的卡", options: ["a", "b"], status: "answered", answer: { plan: "ok" } },
  ],
  getConversationRuns: async () => [
    { runId: "r_offline", workflowId: "synthetic-3step", status: "completed", steps: [{ stepId: "s1", status: "completed" }] },
  ],
}));

const { useChat } = await import("../src/store/chat");
const initial = { ...useChat.getState() };
beforeEach(() => {
  useChat.setState(initial);
  // 进入会话（真实 switch 后 conversationId 落定——reconcile 守卫基于它）
  useChat.setState({ conversationId: "c1", workspaceId: "ws_company" });
});

describe("reconcile（断流重连三快照对账）", () => {
  test("断流期间的消息/卡/run 变化在重连后可见；live 快照幂等合并不重复", async () => {
    // live：重连前已有 id=1 的旧消息 + 一个未定稿占位；卡 pending；无 run
    useChat.setState({
      messages: [
        { id: 1, role: "user" as const, blocks: [{ kind: "text" as const, text: "旧版内容" }], status: "complete" as const },
        { id: null as never, role: "assistant" as const, blocks: [{ kind: "text" as const, text: "流式中占位" }], status: "streaming" as const },
      ],
      questions: [{ id: 7, runId: null, kind: "ask" as const, workflowId: null, prompt: "断流期间的卡", options: ["a", "b"], status: "pending" as const }],
      runs: [],
    });
    await useChat.getState().reconcile("c1");
    const s = useChat.getState();
    // 消息：旧 id=1 被快照版覆盖、占位丢弃、断流期新消息 id=2 并入 → 按 id 序 [1,2]
    expect(s.messages.map((m) => m.id)).toEqual([1, 2]);
    expect((s.messages.find((m) => m.id === 1)!.blocks.find((b) => b.kind === "text") as { kind: "text"; text: string }).text).toBe("重连前的消息");
    expect(s.messages.some((m) => m.id === null)).toBe(false);
    // 卡：pending → answered（断流期间被答）
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0].status).toBe("answered");
    // run：断流期间 completed 的 run 出现
    expect(s.runs.map((r) => r.runId)).toEqual(["r_offline"]);
    expect(s.runs[0].status).toBe("completed");
  });

  test("重连对账幂等：重复 reconcile 不膨胀（不重复消息/卡/run）", async () => {
    await useChat.getState().reconcile("c1");
    const once = useChat.getState();
    await useChat.getState().reconcile("c1");
    const twice = useChat.getState();
    expect(twice.messages.map((m) => m.id)).toEqual(once.messages.map((m) => m.id));
    expect(twice.questions).toHaveLength(once.questions.length);
    expect(twice.runs).toHaveLength(once.runs.length);
    expect(twice.messages).toHaveLength(2);
  });

  test("切换走后对账不写（竞态守卫：conversationId 已变 → 丢弃快照）", async () => {
    useChat.setState({ conversationId: "c_other" }); // 对账进行中用户切走了
    await useChat.getState().reconcile("c1"); // 对 c1 请求，但当前已是 c_other
    expect(useChat.getState().runs).toEqual([]); // 未写入（守卫）
  });
});