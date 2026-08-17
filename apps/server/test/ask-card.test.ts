// #46/T3（ADR-0025 决策 5/6）：ask 步契约 + 挂起强制卡。
// seam：ask 工厂单元（直接 execute）+ store.suspendWithAskCard（同事务）+ registry 集成（synthetic → 卡 + hitl_request）。
import { describe, test, expect } from "bun:test";
import { ask } from "../src/workflow-engine/ask";
import { schema } from "../src/workflow-engine/schema";
import type { StepContext } from "../src/workflow-engine/defineWorkflow";
import { openDbMigrated } from "../src/db/client";
import { WorkflowStore } from "../src/workflow-engine/store";
import { EventBus } from "../src/chat/eventbus";
import { RunRegistry } from "../src/runs/registry";
import type { ConfiguredRunPi } from "../src/pi/runPi-factory";

const stubFactory = (): ConfiguredRunPi => async () => ({ text: "", messages: [], toolResults: [] });
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const delayUntil = async (pred: () => boolean, timeoutMs = 3000): Promise<void> => {
  const s = Date.now();
  while (Date.now() - s < timeoutMs) { if (pred()) return; await delay(15); }
  throw new Error("timeout");
};

const ctx = (over: Partial<StepContext> = {}): StepContext => ({
  input: {}, resumed: undefined, runPi: async () => ({ text: "", messages: [], toolResults: [] }),
  workspaceId: "ws_test", runId: "r1", cwd: "/tmp/x", signal: new AbortController().signal, log: () => {},
  ...over,
});

describe("ask 工厂 · 定义与映射", () => {
  test("显式 {label,value} → payload.options/resumeSchema；resumed 走 mapAnswer + route", async () => {
    const step = ask({
      question: () => "怎么选？",
      options: [
        { label: "A", value: { selected: "all" } },
        { label: "B", value: { selected: "1,3,5" } },
      ],
      resumeSchema: schema.object({ selected: schema.string() }),
      mapAnswer: (input, answer) => ({ ...(input as object), selected: (answer as any).selected }),
      route: (answer) => ((answer as any).selected === "1,3,5" ? "next-step" : undefined),
    });
    // 首跑 → suspend（ask 契约 payload）
    const sus = (await step.execute(ctx({ input: { brand: "x" } }))) as any;
    expect(sus.__suspend.payload.question).toBe("怎么选？");
    expect(sus.__suspend.payload.options).toEqual([
      { label: "A", value: { selected: "all" } },
      { label: "B", value: { selected: "1,3,5" } },
    ]);
    // resumed → mapAnswer 产出 + route __next（"1,3,5" → next-step）
    const resumed = await step.execute(ctx({ input: { brand: "x" }, resumed: { selected: "1,3,5" } }));
    expect(resumed).toMatchObject({ brand: "x", selected: "1,3,5", __next: "next-step" });
  });

  test("enum 派生糖：扁平 enum → label=值；对象单 enum → value={[prop]:val}", async () => {
    const flat = ask({ question: "f", resumeSchema: schema.enum("red", "blue") });
    const sus1 = (await flat.execute(ctx())) as any;
    expect(sus1.__suspend.payload.options).toEqual([{ label: "red", value: "red" }, { label: "blue", value: "blue" }]);

    const obj = ask({
      question: "o",
      resumeSchema: schema.object({ decision: schema.enum("accept", "redirect"), note: schema.optional(schema.string()) }),
    });
    const sus2 = (await obj.execute(ctx())) as any;
    expect(sus2.__suspend.payload.options).toEqual([
      { label: "accept", value: { decision: "accept" } },
      { label: "redirect", value: { decision: "redirect" } },
    ]);
  });

  test("定义期断言：显式 options 与可派生 enum 值数不一致 → 构建即抛", () => {
    expect(() =>
      ask({
        question: "x",
        options: [{ label: "a", value: { decision: "a" } }, { label: "b", value: { decision: "b" } }],
        resumeSchema: schema.object({ decision: schema.enum("a", "b", "c") }), // 3 值 vs 2 选项
      }),
    ).toThrow(/选项数/);
  });

  test("无可派生来源（无 options 且无单 enum）→ 构建即抛", () => {
    expect(() => ask({ question: "x", resumeSchema: schema.object({ selected: schema.string() }) })).toThrow(/ask\(\)/);
  });

  test("运行期缺问句 → 兜底文案（不崩、不静默）", async () => {
    const step = ask({ question: undefined as unknown as string, options: [{ label: "a", value: 1 }] });
    const sus = (await step.execute(ctx())) as any;
    expect(sus.__suspend.payload.question).toBe("请继续（工作流待决策）");
  });

  test("resumed 缺省（无 mapAnswer/route）→ {...input, answer}", async () => {
    const step = ask({ question: "q", options: [{ label: "a", value: 1 }] });
    const out = await step.execute(ctx({ input: { v: 7 }, resumed: 1 }));
    expect(out).toEqual({ v: 7, answer: 1 });
  });
});

describe("store · suspendWithAskCard（同事务强制卡）", () => {
  test("suspended 重确认 + createQuestion(values=快照) 一个事务；回读 values 不失效", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "u" });
    store.createRun({ runId: "r1", workflowId: "w", workspaceId: "ws_company", conversationId: "c1", input: {} });
    store.updateRunStatus("r1", "running");
    const qid = store.suspendWithAskCard({
      runId: "r1", conversationId: "c1",
      prompt: "怎么选？", options: ["A", "B"],
      values: [{ label: "A", value: { selected: "all" } }, { label: "B", value: { selected: "1,3,5" } }],
      resumeSchema: schema.object({ selected: schema.string() }),
    });
    expect(qid).toBeGreaterThan(0);
    expect(store.getRun("r1")!.status).toBe("suspended"); // 同事务切挂起
    const q = store.getQuestion(qid)!;
    expect(q.kind).toBe("ask");
    expect(q.runId).toBe("r1");
    expect(q.options).toEqual(["A", "B"]);
    expect(q.values).toEqual([{ label: "A", value: { selected: "all" } }, { label: "B", value: { selected: "1,3,5" } }]); // 快照回读
    expect(q.status).toBe("pending");
  });
});

describe("registry · 挂起强制卡（ADR-0025 决策 6）", () => {
  test("synthetic review 挂起 → 同事务直建 ask 卡 + hitl_request 帧；无伴生消息", async () => {
    const store = new WorkflowStore(openDbMigrated(":memory:"));
    store.createConversation({ id: "c1", workspaceId: "ws_company", userId: "dev-user" });
    const eventBus = new EventBus();
    const registry = new RunRegistry({ store, eventBus, runPiFactory: stubFactory });
    const frames: any[] = [];
    eventBus.subscribe("c1", (f) => frames.push(f));

    const started = registry.start({ conversationId: "c1", workflowId: "synthetic-3step", input: { offset: 0 } });
    if (started.status !== "running") throw new Error(`expected running, got ${started.status}`);
    await delayUntil(() => frames.some((f) => f.type === "hitl_request"));

    expect(frames.some((f) => f.type === "run_suspended")).toBeTrue();
    const req = frames.find((f) => f.type === "hitl_request");
    expect(req.kind).toBe("ask");
    expect(req.options).toEqual(["接受", "偏移 +1 重跑"]);
    const qid = req.questionId;
    const q = store.getQuestion(qid)!;
    expect(q.kind).toBe("ask");
    expect(q.prompt).toBe("第一步结果已产出，如何决策？");
    expect(q.options).toEqual(["接受", "偏移 +1 重跑"]);
    expect(q.values).toEqual([
      { label: "接受", value: { decision: "accept" } },
      { label: "偏移 +1 重跑", value: { decision: "redirect" } },
    ]); // 显式 value 快照（前端只收 label，value 只在服务端）
    expect(store.listQuestions("c1")).toHaveLength(1); // GET /hitl 恢复口径
    expect(store.listMessages("c1")).toHaveLength(0); // 无伴生消息（卡即恢复载体）
  });
});