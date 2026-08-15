// #21/ADR-0020：pi session 文件清理（删除会话时 unlink jsonl）。
// 文件定位与 reader.ts 同规（`*_chat-<conversationId>.jsonl` glob——文件名带 ISO 时间戳前缀不能直拼）。
// 独立文件：reader 依赖 pi-coding-agent 解析器，删除只需文件系统副作用，不该连带。
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** 删 sessionDir 内该会话全部 session 文件（多文件异常也一并清）。返回删除数；目录不存在=0。 */
export function eraseConversationSessions(sessionDir: string, conversationId: string): number {
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter((f) => f.endsWith(`_chat-${conversationId}.jsonl`));
  } catch {
    return 0; // 目录不存在（会话从未跑过 turn）
  }
  for (const f of files) rmSync(join(sessionDir, f));
  return files.length;
}
