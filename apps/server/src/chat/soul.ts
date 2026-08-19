// Soul.md（chat 助手全局沟通契约，ADR-0024）：仓库根全局文件，逐轮读——改文件即调语气，免重启。
// 缺文件→null（turn.ts 省略该段）：契约是产品配置非代码依赖，文件被删不该炸 chat。
// 路径用 fileURLToPath 而非 config.REPO_ROOT：后者 URL.pathname 在含空格路径下成 %20（本 worktree 即踩）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SOUL_PATH = fileURLToPath(new URL("../../../../Soul.md", import.meta.url));

/** 逐轮读 Soul.md；缺失→null。path 参数供测试注入。 */
export function loadSoul(path: string = SOUL_PATH): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
