// ask 步工厂（#46/T3 ADR-0025 决策 5）：挂起点收编为显式 ask 步——question + 显式 {label,value} 选项
// （value 即 resumeData，点击=确定性派发；label=值 enum 派生为语法糖）+ context + route。
// 挂起即出强制卡（引擎直建，零 LLM 转写）；resumed 返 {...上游 input, answer} 续默认链。
// **纯代码不调 pi**（保住无 pi 测试路径）；动态问句/上下文素材由上游 pi 步结构化产出。
import type { Schema } from "./schema";
import { schema } from "./schema";
import type { AskOption, StepDef, StepResult } from "./defineWorkflow";

export interface AskStepDef<TInput = any> {
  question: string | ((input: TInput) => string);
  /** 运行期问句缺失/错型兜底（决策 5：不崩、不静默）。 */
  questionFallback?: string;
  /** 决策辅助 markdown（可读文件预渲染——上游步产出素材由 fn 拼装）。 */
  context?: string | ((input: TInput, ctx: { cwd: string; workspaceId: string; runId: string }) => string | Promise<string>);
  /** 显式映射 {label,value}；缺省从 resumeSchema 顶层单 enum 派生（label=值）。
   *   resumeSchema 一并给（且可派生）时：选项数须与可映射值数一致（定义期断言）。 */
  options?: AskOption[];
  /** 续跑校验契约。显式 options 且未给 → 由各 value 构造 accept-any-of-values。
   *   自由形（如 brand-strategy selected="all"/"1,3,5"）须作者显式给宽 schema——不要 values 锁死打字路径。 */
  resumeSchema?: Schema;
  /** resumed 产出（缺省 {...input, answer}）；__next 由 route 附（若无 route 也可在产出里写）。
   *   第三个参收 ctx（工作流步骤常用 cwd 解析默认产出路径）。 */
  mapAnswer?: (input: TInput, answer: unknown, ctx: { cwd: string; workspaceId: string; runId: string }) => unknown;
  /** 答案路由（ADR-0025：synthetic redirect 循环用 route 表达）；返步 id 或不返（默认链）。 */
  route?: (answer: unknown) => string | null | undefined;
}

/** 顶层单 enum 派生（与 hitl-dispatch deterministicResumeData 同构）：
 *  对象形恰一个 enum 属性、其余全 optional → 其 vals；扁平 enum 形 → 自身 vals。否则空。 */
export function singleEnumVals(s: Schema | undefined): { prop: string | null; vals: unknown[] } {
  if (!s) return { prop: null, vals: [] };
  if (s._t === "enum" && Array.isArray(s.vals)) return { prop: null, vals: s.vals as unknown[] };
  if (s._t !== "object" || !s.shape) return { prop: null, vals: [] };
  const shape = s.shape as Record<string, Schema>;
  const entries = Object.entries(shape);
  const enums = entries.filter(([, c]) => c._t === "enum" && Array.isArray((c as { vals?: unknown[] }).vals));
  if (enums.length !== 1) return { prop: null, vals: [] };
  if (!entries.every(([, c]) => c._t === "enum" || c._t === "optional")) return { prop: null, vals: [] };
  return { prop: enums[0][0], vals: (enums[0][1] as unknown as { vals: unknown[] }).vals };
}

/** enum 派生选项：label=值；value 取值=resumeData 候选——对象形单 enum 包装为 { [prop]: val }（ADR-0022 对位）。 */
function deriveOptions(s: Schema | undefined): AskOption[] {
  const { prop, vals } = singleEnumVals(s);
  return vals.map((v) => ({ label: String(v), value: prop ? { [prop]: v } : v }));
}

// 显式 options → resumeSchema 缺省时由各 value 构造（accept-any-of-values——点击值必然合法）。
function resolveResumeSchema(def: AskStepDef, options: AskOption[]): Schema {
  if (def.resumeSchema) return def.resumeSchema;
  return schema.values(...options.map((o) => o.value));
}

export function ask<TInput = any>(def: AskStepDef<TInput>): StepDef<TInput> {
  const options: AskOption[] = def.options && def.options.length > 0 ? def.options : deriveOptions(def.resumeSchema);
  if (options.length === 0) throw new Error("ask(): 需显式 options 或 resumeSchema 顶层单 enum（无可派发选项）");
  const resumeSchema = resolveResumeSchema(def, options);
  // 定义期断言：显式 options + 可派生 resumeSchema 计数不一致 = 作者笔误（选项不覆盖全部可选值）。
  const { vals } = singleEnumVals(resumeSchema);
  if (def.options && vals.length > 0 && def.options.length !== vals.length) {
    throw new Error(`ask(): 选项数(${def.options.length})与 resumeSchema 可映射值数(${vals.length})不一致`);
  }
  const fallbackQ = def.questionFallback ?? "请继续（工作流待决策）";

  return {
    async execute(ctx): Promise<StepResult> {
      const { input, resumed } = ctx;
      if (resumed !== undefined) {
        const out: Record<string, unknown> = def.mapAnswer
          ? (def.mapAnswer(input, resumed, { cwd: ctx.cwd, workspaceId: ctx.workspaceId, runId: ctx.runId }) as Record<string, unknown>)
          : { ...(input as object), answer: resumed };
        if (def.route) {
          const next = def.route(resumed);
          if (next) out.__next = next;
        }
        return out as StepResult;
      }
      let q = typeof def.question === "function" ? (def.question(input) as unknown) : def.question;
      if (typeof q !== "string" || !q.trim()) q = fallbackQ; // 运行期缺问句兜底（不崩、不静默）
      let context: string | undefined;
      if (def.context) {
        const c = typeof def.context === "function"
          ? await def.context(input, { cwd: ctx.cwd, workspaceId: ctx.workspaceId, runId: ctx.runId })
          : def.context;
        context = typeof c === "string" ? c : undefined;
      }
      return {
        __suspend: {
          payload: { question: q, options, ...(context ? { context } : {}) },
          resumeSchema,
        },
      };
    },
  };
}