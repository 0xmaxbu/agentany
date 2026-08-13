// 3 步合成工作流：验证线性 + HITL 循环 + 终结（spike-b 那个）。
// 纯程序步（不调 runPi）→ 引擎测试与 HTTP e2e 都无需真 pi；runPi 真链路另测。
import { defineWorkflow } from "../workflow-engine/defineWorkflow";
import { schema } from "../workflow-engine/schema";

export const synthetic = defineWorkflow({
  id: "synthetic-3step",
  name: "合成三步",
  description: "验证线性 + HITL 循环 + 终结（s1→review→s2）",
  inputSchema: schema.object({ offset: schema.optional(schema.number()) }),
  extensions: [],
})
  .step("s1", {
    // 纯程序步：产出值，带 offset。
    async execute({ input }) {
      const offset = ((input as any)?.offset as number) ?? 0;
      return { value: `s1-out@off${offset}`, offset };
    },
  })
  .step("review", {
    // HITL：首跑 suspend 问 accept/redirect；resume 据 decision 走分支。
    async execute({ input, resumed }) {
      if (resumed) {
        if (resumed.decision === "redirect") {
          // 循环：命令式回 s1，带 +1 offset（演示循环携带新数据）
          return { __next: "s1", offset: (((input as any)?.offset as number) ?? 0) + 1, focus: resumed.focus ?? null };
        }
        return { accepted: true, value: (input as any)?.value }; // accept → 默认链 → s2
      }
      return {
        __suspend: {
          payload: { produced: (input as any)?.value, offset: ((input as any)?.offset as number) ?? 0 },
          resumeSchema: schema.object({
            decision: schema.enum("accept", "redirect"),
            focus: schema.optional(schema.string()),
          }),
        },
      };
    },
  })
  .step("s2", {
    // 终结
    async execute({ input }) {
      return { final: `s2-final(${JSON.stringify(input)})`, done: true };
    },
  })
  .commit();
