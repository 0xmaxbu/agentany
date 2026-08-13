// ticket #18：QM 审批门 CommandPolicy。
//
// **窄口径声明**：本模块仅是【workflow 启动门】（start_workflow 桥接路径上的 allow/deny/require_approval），
// **不是** ADR-0011 的通用 authorize() chokepoint。ADR-0011:59 曾否决「posture 命名轴现在立」；
// #18 以窄口径重引入——只决定「某 workflow 能否经 chat 启动」，不接 extension 级通用授权。
// A2 真 auth 阶段统一收口（见 ADR-0011 追加注记）。
//
// fail-closed（契 ADR-0011:24「非明确 allow 即拒」）：auto posture 下无规则匹配 → deny。
// posture 在调用时读 env（decide 不传 posture → resolvePosture → process.env.SECURITY_POSTURE）；
// 缺省/非法 → auto。测试显式传 posture，禁 set process.env（防泄漏）。

export type Posture = "dangerous" | "auto" | "strict";
export type Decision = "allow" | "deny" | "require_approval";

export interface CommandRule {
  workflowId: string; // "*" = 通配（命中任何未精确匹配的工作流）
  decision: Decision;
}

export interface PolicyVerdict {
  decision: Decision;
  reason: string;
}

// 三 posture 规则集。auto 故意无 "*" —— 未列工作流 fail-closed deny。
export const POSTURES: Record<Posture, CommandRule[]> = {
  dangerous: [{ workflowId: "*", decision: "allow" }], // 本地 dev：全放、无审批
  auto: [
    { workflowId: "synthetic-3step", decision: "allow" },
    { workflowId: "brand-research", decision: "require_approval" },
    { workflowId: "brand-strategy-analysis", decision: "require_approval" },
  ],
  strict: [{ workflowId: "*", decision: "require_approval" }], // 一切需审批
};

const VALID: ReadonlySet<string> = new Set(["dangerous", "auto", "strict"]);

/** 解析 posture：显式 env 优先；非法/缺省 → auto（warn，不抛）。 */
export function resolvePosture(env?: string): Posture {
  const raw = env ?? process.env.SECURITY_POSTURE;
  if (raw && VALID.has(raw)) return raw as Posture;
  if (raw) console.warn(`[policy] unknown SECURITY_POSTURE='${raw}', fallback to auto`);
  return "auto";
}

/**
 * 判定某 workflow 在某 posture 下的处置。首匹配（精确 id 优先于 "*"）；无匹配 → deny（fail-closed）。
 * posture 缺省 → resolvePosture() 读 process.env（调用时读，非启动时缓存）。
 */
export function decide(workflowId: string, posture?: Posture): PolicyVerdict {
  const p = posture ?? resolvePosture();
  const rules = POSTURES[p];
  const rule = rules.find((r) => r.workflowId === workflowId) ?? rules.find((r) => r.workflowId === "*");
  if (!rule) return { decision: "deny", reason: `no allow rule for '${workflowId}' under ${p} (fail-closed)` };
  return { decision: rule.decision, reason: `${p}:${rule.workflowId}` };
}
