// spikes/spike-b/defineWorkflow.mjs — Mastra 风格 fluent builder（手搓，不用 @mastra）。
// 默认链按声明顺序；execute 返回 { ...output, __next?: "stepId" } 命令式覆盖下一步（可往回=循环）。
export function defineWorkflow({ id, inputSchema, start }) {
  const steps = {};
  const order = [];
  const api = {
    step(stepId, def) {
      if (stepId in steps) throw new Error(`duplicate step: ${stepId}`);
      steps[stepId] = def;
      order.push(stepId);
      return api;
    },
    commit() {
      if (order.length === 0) throw new Error("workflow has no steps");
      const resolvedStart = start ?? order[0];
      return {
        id,
        inputSchema,
        steps,
        order,
        start: resolvedStart,
        defaultNext(stepId) {
          const i = order.indexOf(stepId);
          return i >= 0 && i < order.length - 1 ? order[i + 1] : null; // 末步 → null = 终结
        },
      };
    },
  };
  return api;
}
