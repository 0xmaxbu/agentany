// spikes/spike-b/workflow.mjs — 3 步合成工作流（验证：线性 + HITL 循环 + 终结）。
// stub 代替 runPi（隔离引擎机制；runPi 已在 Spike A 验过）。
import { defineWorkflow } from "./defineWorkflow.mjs";
import { schema } from "./schema.mjs";

// spike stub。prod = apps/server/src/pi/runPi.ts（Spike A 产出）。
async function stubRunPi({ prompt }) {
  return { text: `[stub-pi] ${prompt}` };
}

export function buildWorkflow() {
  return defineWorkflow({
    id: "synthetic-3step",
    inputSchema: schema.object({ offset: schema.optional(schema.number()) }),
    start: "s1",
  })
    .step("s1", {
      // 产出值；演示 ctx.runPi 可用。offset 默认 0。
      async execute({ input, runPi }) {
        const offset = input?.offset ?? 0;
        const r = await runPi({ prompt: `produce s1 @${offset}` });
        return { value: `${r.text}@off${offset}`, offset };
      },
    })
    .step("review", {
      // HITL：首跑 suspend 问 accept/redirect；resume 据 decision 走分支。
      async execute({ input, resumed }) {
        if (resumed) {
          if (resumed.decision === "redirect") {
            // 循环：命令式回 s1，并带上 +1 后的 offset（演示「循环携带新数据」）
            return { __next: "s1", offset: (input?.offset ?? 0) + 1, focus: resumed.focus ?? null };
          }
          // accept → 默认链 → s2
          return { accepted: true, value: input?.value };
        }
        // 首跑：suspend（此分支须廉价无副作用 —— 不调 runPi）
        return {
          __suspend: {
            payload: { produced: input?.value, offset: input?.offset ?? 0 },
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
}

export { stubRunPi };
