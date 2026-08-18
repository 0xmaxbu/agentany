// T4（#53）：前端 store 单测——switchConversation 从 GET /runs 快照装入 runs（run 卡刷新恢复）。
// seam：mock.module 桩 api 层全部运行时导出（缺命名导出即链接失败），驱动真 store 的 switchConversation。
import { describe, test, expect, beforeEach, mock } from "bun:test";

const RUN_FIXTURE = [
  { runId: "r_completed", workflowId: "synthetic-3step", status: "completed", steps: [{ stepId: "s1", status: "completed" }, { stepId: "review", status: "completed" }], brief: "完成简报" },
  { runId: "r_suspended", workflowId: "brand-research", status: "suspended", steps: [{ stepId: "s0", status: "completed" }], brief: null },
];

const unused = () => { throw new Error("api stub: not used in runs-restore test"); };

mock.module("../src/api", () => ({
  setOnUnauthorized: () => {},
  apiFetch: unused,
  createConversation: unused,
  listConversations: async () => [],
  archiveConversation: unused,
  restoreConversation: unused,
  deleteConversation: unused,
  listWorkspaces: async () => [],
  rateMessage: unused,
  getMessageFeedback: unused,
  rateRun: unused,
  getRunFeedback: unused,
  fetchFile: unused,
  listScheduledTasks: async () => [],
  listTaskRuns: async () => [],
  runTaskNow: unused,
  setTaskEnabled: unused,
  deleteTask: unused,
  markTaskViewed: unused,
  createSystemTask: unused,
  updateTask: unused,
  abortConversation: async () => {},
  postMessage: unused,
  DISTILL_TASK_ID: "",
  isDistillSeed: () => false,
  // ── 本测试用的网络桩 ──
  getMessages: async () => [],
  getHitlQuestions: async () => [],
  getConversationFiles: async () => [],
  getConversationRuns: async (id: string) => (id === "no-runs" ? [] : RUN_FIXTURE),
  openStream: async () => {}, // 持久流静默结束（不入 error 分支）
}));

const { useChat } = await import("../src/store/chat");
const initial = { ...useChat.getState() }; // 捕获 pristine 态（模块载入即取）
beforeEach(() => {
  useChat.setState(initial); // 全键重置（浅合并函数引用不变）
});

describe("switchConversation 装入 runs（#53/T4）", () => {
  test("切换会话 → runs 由 GET /runs 快照填充（status/steps 形状 = UIRun）", async () => {
    await useChat.getState().switchConversation("c1");
    const runs = useChat.getState().runs;
    expect(runs).toHaveLength(2);
    const completed = runs.find((r) => r.runId === "r_completed")!;
    expect(completed.status).toBe("completed");
    expect(completed.workflowId).toBe("synthetic-3step");
    expect(completed.steps).toEqual([
      { stepId: "s1", status: "completed" },
      { stepId: "review", status: "completed" },
    ]);
    expect(runs.find((r) => r.runId === "r_suspended")!.status).toBe("suspended");
  });

  test("无 run 会话 → runs 空数组（不恒空、不报错）", async () => {
    await useChat.getState().switchConversation("no-runs");
    expect(useChat.getState().runs).toEqual([]);
  });

  test("前端 onFrame 快照合并仍工作：恢复后 step_* 帧增量更新既有 run（不重复追加 run）", async () => {
    await useChat.getState().switchConversation("c1");
    const { onFrame } = useChat.getState();
    onFrame({ type: "step_completed", runId: "r_completed", stepId: "s3", status: "completed" } as never);
    await Promise.resolve();
    const runs = useChat.getState().runs;
    expect(runs).toHaveLength(2); // 不重复追加 run 对象
    const comp = runs.find((r) => r.runId === "r_completed")!;
    expect(comp.steps.some((s) => s.stepId === "s3")).toBe(true);
  });
});