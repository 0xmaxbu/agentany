// Mastra 风格 fluent builder（手搓，不用 @mastra；ADR-0001/0007）。
// 默认链按声明顺序；execute 返回 { ...output, __next?: "stepId" } 命令式覆盖下一步（可往回=循环）。
import type { Schema } from "./schema";

export interface RunPiResult {
  text: string;
  messages: unknown[];
  toolResults: unknown[];
  sessionId?: string;
}

export interface StepContext<TInput = any> {
  input: TInput;
  resumed?: any; // 续跑数据（resume 时引擎注入）
  runPi: (opts: { prompt: string; timeoutMs?: number }) => Promise<RunPiResult>;
  workspaceId: string;
  runId: string;
  cwd: string; // workspace 工作区（ADR-0006/0018），step 据它算产出路径
  signal: AbortSignal;
  log: (...args: unknown[]) => void;
}

export interface SuspendSpec {
  payload: any;
  resumeSchema: Schema;
}

// 步结果：正常产出（可带 __next）或 suspend。
export type StepResult<TOutput = any> =
  | (TOutput & { __next?: string })
  | { __suspend: SuspendSpec };

export interface StepDef<TInput = any, TOutput = any> {
  outputSchema?: Schema;
  execute: (ctx: StepContext<TInput>) => Promise<StepResult<TOutput>>;
}

export interface Workflow {
  id: string;
  name?: string;
  description?: string;
  inputSchema?: Schema;
  outputSchema?: Schema;
  extensions?: string[]; // -e 显式扩展（ADR-0005）。skills 走标准发现，不在此声明。
  roles?: string[];
  steps: Record<string, StepDef>;
  order: string[];
  start: string;
  defaultNext(stepId: string): string | null;
}

interface WorkflowBuilder {
  step: (id: string, def: StepDef) => WorkflowBuilder;
  commit: () => Workflow;
}

export function defineWorkflow(opts: {
  id: string;
  name?: string;
  description?: string;
  inputSchema?: Schema;
  outputSchema?: Schema;
  extensions?: string[];
  roles?: string[];
  start?: string;
}): WorkflowBuilder {
  const steps: Record<string, StepDef> = {};
  const order: string[] = [];

  const api: WorkflowBuilder = {
    step(id: string, def: StepDef) {
      if (id in steps) throw new Error(`duplicate step: ${id}`);
      steps[id] = def;
      order.push(id);
      return api;
    },
    commit(): Workflow {
      if (order.length === 0) throw new Error(`workflow ${opts.id} has no steps`);
      return {
        ...opts,
        steps,
        order,
        start: opts.start ?? order[0],
        defaultNext(stepId: string) {
          const i = order.indexOf(stepId);
          return i >= 0 && i < order.length - 1 ? order[i + 1] : null; // 末步 → null = 终结
        },
      };
    },
  };
  return api;
}
