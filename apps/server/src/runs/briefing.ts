// 运行简报构造（#41/T1 ADR-0025 决策 1/2/4）：纯函数，registry 装配。
// - brief 契约：末步 output.brief（string、首句直说结果、软预算 BRIEF_MAX）；缺失/错型 → 步骤列表兜底。
// - artifacts 白名单：仅精确匹配渲染 /files 链接（零误命中），前端既有 markdown 零改造。
// - read_run 封顶：latestOutput stringify 截 READ_TRUNCATE + 尾注（简报管面、read_run 管深）。
export const BRIEF_MAX = 200;
export const READ_TRUNCATE = 8000;
export const READ_FOOTER = "…（已截断，全文见 DB/文件）";

/** 末步 output 提 brief（校验 string、取首行、≤BRIEF_MAX）。缺失/错型/空 → undefined（调用方兜底）。 */
export function extractBrief(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const b = (output as any).brief;
  if (typeof b !== "string") return undefined;
  const firstLine = b.split("\n")[0].trim();
  if (!firstLine) return undefined;
  return firstLine.length > BRIEF_MAX ? firstLine.slice(0, BRIEF_MAX) : firstLine;
}

/** 末步 output 提 artifacts（string[]，ws 相对路径；非数组/错型 → 空）。 */
export function extractArtifacts(output: unknown): string[] {
  if (!output || typeof output !== "object") return [];
  const a = (output as any).artifacts;
  if (!Array.isArray(a)) return [];
  return a.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** failed note 截首行/≤BRIEF_MAX（note 即简报）。 */
export function extractNoteBrief(note: unknown): string {
  const s = String(note ?? "未知错误").trim().split("\n")[0];
  return s.length > BRIEF_MAX ? s.slice(0, BRIEF_MAX) : s;
}

/** 确定性兜底（决策 1）：缺 brief → 步骤列表摘要。不崩、不静默。 */
export function stepListFallback(log: { stepId: string; status: unknown }[]): string {
  const s = log.map((e) => `${e.stepId}(${e.status})`).join(", ") || "（无步骤日志）";
  return `已完成步骤：${s}`;
}

/** 简报 linkify（决策 4）：对 artifacts 精确匹配生成 markdown 链接（默认 /files inline）。非白名单字样不动。 */
export function linkifyArtifacts(content: string, artifacts: string[], workspaceId: string): string {
  if (artifacts.length === 0) return content;
  // 长路径先替换（防子串互相污染）；字面量替换（split/join）——路径含正则元字符安全。
  for (const art of [...artifacts].sort((a, b) => b.length - a.length)) {
    if (!content.includes(art)) continue;
    content = content.split(art).join(`[${art}](${`/files/${workspaceId}/${art}`})`);
  }
  return content;
}

/** 简报消息整体（前缀自标识 + 内容 linkify）。 */
export function buildBriefMessage(p: {
  workflowId: string;
  terminal: "completed" | "failed";
  brief: string;
  artifacts: string[];
  workspaceId: string;
}): string {
  const prefix = `📋 工作流 ${p.workflowId} ${p.terminal === "completed" ? "完成" : "失败"}：`;
  return linkifyArtifacts(prefix + p.brief, p.artifacts, p.workspaceId);
}

/** read_run latestOutput 封顶：stringify 测长，超 READ_TRUNCATE → 截断串 + 尾注；短输出原样返（对象不串化）。 */
export function truncateForRead(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const s = JSON.stringify(v);
  if (s.length <= READ_TRUNCATE) return v;
  return s.slice(0, READ_TRUNCATE) + READ_FOOTER;
}