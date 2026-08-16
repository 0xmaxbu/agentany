// #30/M4-3b 产出文件：路径归一 + 防逃逸（纯函数，execute 收集与 /files 路由共用同一口径）。
import { isAbsolute, relative, resolve, sep } from "node:path";

/** pi 内置写类工具（write/edit 都带 path 参数——dist/core/tools/*.d.ts 实证）；bash 写文件 v1 不收集。 */
export const WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * tool_use 报的 path（pi cwd 相对或绝对）→ ws 相对路径（POSIX 分隔，task_files.path 形态）。
 * 逃逸（../ 出 cwd / cwd 外绝对路径）→ undefined（不登记——ws 外文件不属于本 ws 产出）。
 */
export function wsRelativePath(cwd: string, p: string): string | undefined {
  if (typeof p !== "string" || p.length === 0) return undefined;
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined; // 出 cwd（含 cwd 本身）
  return rel.split(sep).join("/");
}
