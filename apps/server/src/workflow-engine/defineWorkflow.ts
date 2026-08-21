// Mastra 风格 fluent builder（手搓，不用 @mastra；ADR-0001/0007）。
// 默认链按声明顺序；execute 返回 { ...output, __next?: "stepId" } 命令式覆盖下一步（可往回=循环）。
import type { Schema } from "./schema";
// ADR-0033/R-1（#73）的设备环境要求类型已下沉 @agentany/ws-protocol（ADR-0034 D2，check_environment 线帧随带）；
// DSL 仅在此 import + re-export（消费方保持原路径不变）。
import type { EnvRequirement } from "@agentany/ws-protocol";

export type { EnvRequirement };

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

// ADR-0025（#46/T3）：挂起点收编为 ask 契约——显式 {label,value} 映射（value 即 resumeData，点击=确定性派发）；
// 引擎挂起时同事务直建强制卡。SuspendSpec.payload 由 any 收紧（breaking，单仓自研无兼容期）。
export interface AskOption {
  label: string;
  value: unknown; // 服务端消费（resumeData 候选）；前端只收 label 不下行 value
}

export interface AskPayload {
  question: string;
  options: AskOption[]; // 已解析（显式或 enum 派生）——引擎贴卡用，上游者不改
  context?: string; // 预渲染 markdown（决策辅助）
}

export interface SuspendSpec {
  payload: AskPayload;
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
  // ADR-0033/R-1（#73）：工具声明与设备环境要求——remote 判定（R-3 preflight）与 stub 生成（R-5）以此为据。
  tools?: string[]; // 本工作流将调用的全部工具名（查全局工具注册表，见 tool-registry）
  environment?: EnvRequirement[]; // 设备环境要求（仅 remote 工作流消费）
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
  tools?: string[];
  environment?: EnvRequirement[];
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
