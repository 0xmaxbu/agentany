// 块领域常量 + 类型（f3/ADR-0019 唯一源）：与 server src/blocks.ts 同构。
// 所有对 kind/帧 type 的字符串判断**必须引用本文件常量**——散落字面量会漂移（Primitive Obsession 根治）。
export const BLOCK_KIND = {
  text: "text",
  thinking: "thinking",
  toolUse: "tool_use",
  toolResult: "tool_result",
} as const;
export type BlockKind = (typeof BLOCK_KIND)[keyof typeof BLOCK_KIND];

// 帧类型常量（SSEEvent.type 子集——块三帧）
export const BLOCK_FRAME = {
  start: "block_start",
  delta: "block_delta",
  end: "block_end",
} as const;

export type Block =
  | { kind: typeof BLOCK_KIND.text; text: string }
  | { kind: typeof BLOCK_KIND.thinking; text: string }
  | { kind: typeof BLOCK_KIND.toolUse; toolCallId: string; name: string; arguments: unknown }
  | { kind: typeof BLOCK_KIND.toolResult; toolCallId: string; toolName: string; text: string; isError: boolean };

// ---- meta 解析（block_start.meta 形状收口——散落 as 断言会漂移） ----
export const parseToolUseMeta = (meta: Record<string, unknown> | undefined): { toolCallId?: string; name?: string; arguments?: unknown } => ({
  toolCallId: typeof meta?.toolCallId === "string" ? meta.toolCallId : undefined,
  name: typeof meta?.name === "string" ? meta.name : undefined,
  arguments: meta?.arguments,
});
export const parseToolResultMeta = (meta: Record<string, unknown> | undefined): { toolCallId?: string; toolName?: string; isError?: boolean } => ({
  toolCallId: typeof meta?.toolCallId === "string" ? meta.toolCallId : undefined,
  toolName: typeof meta?.toolName === "string" ? meta.toolName : undefined,
  isError: meta?.isError === true ? true : undefined,
});

// ---- tool_use 宿主查找（消息列表形状的最小契约——store 供 UIMessage 泛型用） ----
export interface BlockHost<M> {
  msg: M;
  block: { kind: typeof BLOCK_KIND.toolUse; toolCallId: string; result?: { text: string; isError: boolean } };
}
/** 倒序（最近优先）在消息列表里按 toolCallId 找 tool_use 块及其宿主消息（跨消息归属）。 */
export function findToolUse<M extends { role: string; blocks: { kind: string; toolCallId?: string; result?: unknown }[] }>(
  msgs: M[],
  toolCallId: string,
): BlockHost<M> | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    const b = m.blocks.find((x) => x.kind === BLOCK_KIND.toolUse && x.toolCallId === toolCallId);
    if (b) return { msg: m, block: b as BlockHost<M>["block"] };
  }
  return null;
}
