// pi session 读取（#20）：消息历史真相源 = pi session jsonl（blocks 结构齐全）；DB messages 表退为文本冗余。
// 文件定位：sessionDir 内 `*_chat-<conversationId>.jsonl`（文件名带 ISO 时间戳前缀，不能直拼）；
// 同 id 多文件取最新 mtime（与 pi CLI findLocalSessionByExactId 的选取一致——二次审核②）。
// 不自解析 jsonl：用 @earendil-works/pi-coding-agent 的 parseSessionEntries（#20 明确要求；0.83.0 无 loadEntriesFromFile）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { flattenText, partsToBlocks, textOf, type Block } from "../blocks";

/** 历史消息（GET /conversations/:id/messages 的新形状；与实时 block 帧同构）。 */
export interface HistoryMessage {
  id: string; // session entry id（树节点 id，非 DB 自增）
  dbId?: number | null; // #34 对齐回填的 DB messages.id（消息级反馈锚；null=DB 无对应行）
  role: "user" | "assistant";
  content: string; // text blocks 拼接（冗余字段——前端 f3 前的兼容；#20 冗余比对用）
  blocks: Block[];
  createdAt: string; // entry timestamp
}

/**
 * toolResult 行归属：优先按 toolCallId 对位到产出该 toolCall 的 assistant 消息
 * （pi 串行执行时 = 最近 assistant，但对位才不依赖顺序假设）；对不上（孤儿/错位）兜底最近 assistant。
 */
const attachToolResult = (out: HistoryMessage[], block: Block): void => {
  let target: HistoryMessage | undefined;
  if (block.kind === "tool_result") {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role !== "assistant") continue;
      if (out[i].blocks.some((b) => b.kind === "tool_use" && b.toolCallId === block.toolCallId)) { target = out[i]; break; }
      if (!target) target = out[i]; // 记住最近 assistant 作兜底
    }
  }
  if (target) target.blocks.push(block); // 孤儿 toolResult（无前导 assistant）丢弃
};

/**
 * 读会话历史（sessionDir 按 conv.workspaceId 经 scopeOf/resolveScopePaths 解析后传入）。
 * 无 session 文件（e2e stub 路径 / 新会话首轮前）→ null，路由兜底 DB。
 */
export function readConversationHistory(sessionDir: string, conversationId: string): HistoryMessage[] | null {
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter((f) => f.endsWith(`_chat-${conversationId}.jsonl`));
  } catch {
    return null; // 目录不存在（会话从未跑过 turn）
  }
  if (files.length === 0) return null;

  // 最新者胜（正常恰 1 个；异常多文件与 CLI 选取一致）：mtime 优先，文件名 ISO 前缀（创建时间）破并列
  const latest = files
    .map((f) => ({ f, m: statSync(join(sessionDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m || b.f.localeCompare(a.f))[0].f;

  const entries = parseSessionEntries(readFileSync(join(sessionDir, latest), "utf8"));
  const out: HistoryMessage[] = [];
  for (const e of entries as any[]) {
    if (e?.type !== "message" || !e.message) continue;
    const msg = e.message;
    // user/assistant 同构映射（partsToBlocks 双分支覆盖裸 string/parts）；toolResult 单独归属。
    if (msg.role === "user" || msg.role === "assistant") {
      const blocks = partsToBlocks(msg.content);
      out.push({ id: String(e.id ?? ""), role: msg.role, content: textOf(blocks), blocks, createdAt: String(e.timestamp ?? "") });
    } else if (msg.role === "toolResult") {
      attachToolResult(out, {
        kind: "tool_result",
        toolCallId: String(msg.toolCallId ?? ""),
        toolName: String(msg.toolName ?? ""),
        text: flattenText(msg.content),
        isError: msg.isError === true,
      });
    }
  }
  return out;
}

/** DB messages 行（e2e stub 兜底源）→ HistoryMessage 形状（包一层 text block——前端 f3 前不破契约）。 */
export function dbMessagesToHistory(rows: { id: number | string; role: string; content: string; createdAt: string }[]): HistoryMessage[] {
  return rows.map((m) => ({
    id: String(m.id),
    dbId: Number(m.id), // #34 DB 兜底源：id 本即 DB messages.id（前端反馈锚只认 dbId——与 pi 源对齐值同字段）
    role: m.role as HistoryMessage["role"],
    content: m.content,
    blocks: [{ kind: "text", text: m.content }],
    createdAt: m.createdAt,
  }));
}

// TODO(#20 差异比对)：messages 表冗余 vs pi session reader 的比对钩子——
// readConversationHistory 返回非 null 时，与 deps.store.listMessages(conv.id) 比对条数/文本，
// 不一致打日志（数据完整性巡检）。v1 暂不实现（#20 AC「最小比对占位」）。
