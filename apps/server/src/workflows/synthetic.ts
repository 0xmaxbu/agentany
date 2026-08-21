// 3 步合成工作流：验证线性 + HITL 循环 + 终结（spike-b 那个）。
// 纯程序步（不调 runPi）→ 引擎测试与 HTTP e2e 都无需真 pi；runPi 真链路另测。
import { defineWorkflow } from "../workflow-engine/defineWorkflow";
import { ask } from "../workflow-engine/ask";
import { schema } from "../workflow-engine/schema";

export const synthetic = defineWorkflow({
  id: "synthetic-3step",
  name: "合成三步",
  description: "验证线性 + HITL 循环 + 终结（s1→review→s2）",
  inputSchema: schema.object({ offset: schema.optional(schema.number()) }),
  extensions: [],
  tools: [], // 纯程序步——不调用任何工具
})
  .step("s1", {
    // 纯程序步：产出值，带 offset。
    async execute({ input }) {
      const offset = ((input as any)?.offset as number) ?? 0;
      return { value: `s1-out@off${offset}`, offset };
    },
  })
  .step("review", ask({
    // #46/T3 ADR-0025 决策 5：挂起点收编为 ask 步——显式 {label,value}（enable redirect 循环用 route）。
    // 定义期断言：2 选项 vs resumeSchema 顶层 enum 2 值 一致（pass）。
    // context（决策辅助 markdown，code-review F4 全链透出）：把 s1 产出摆进卡里。
    question: () => "第一步结果已产出，如何决策？",
    context: (input) => `当前产出：${(input as { value?: string }).value ?? "（无）"}`,
    options: [
      { label: "接受", value: { decision: "accept" } },
      { label: "偏移 +1 重跑", value: { decision: "redirect" } },
    ],
    resumeSchema: schema.object({
      decision: schema.enum("accept", "redirect"),
      focus: schema.optional(schema.string()),
    }),
    mapAnswer: (input, answer) => ({
      ...(input as object),
      accepted: (answer as any).decision === "accept",
      focus: (answer as any).focus ?? null,
      // redirect：把 +1 offset 传给 s1 的 input（s1 回读 input.offset）——循环携带新数据
      offset: (answer as any).decision === "redirect" ? ((input as any)?.offset as number ?? 0) + 1 : (input as any)?.offset,
    }),
    route: (answer) => ((answer as any)?.decision === "redirect" ? "s1" : undefined),
  }))
  .step("s2", {
    // 终结
    async execute({ input }) {
      return { final: `s2-final(${JSON.stringify(input)})`, done: true };
    },
  })
  .commit();
