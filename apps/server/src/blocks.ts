// Block 模型（#20 / ADR-0016 parts 架构）：消息 = blocks 序列（text/thinking/tool_use/tool_result）。
// 实时（pi NDJSON 事件 → StreamBlock 三帧）与历史（pi-session/reader.ts → Block[]）在此同构。
// 顶层中立模块（非 chat/ 下）：pi 与 pi-session 两层都要用，放 chat 会造成底层反向依赖上层。
export type BlockKind = "text" | "thinking" | "tool_use" | "tool_result";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolCallId: string; name: string; arguments: unknown }
  | { kind: "tool_result"; toolCallId: string; toolName: string; text: string; isError: boolean };

// 三帧 payload（EventBus block_* 帧的data体；turn.ts 直接映射成 Frame）。
export type StreamBlock =
  | { op: "start"; blockId: string; kind: BlockKind; meta?: Record<string, unknown> }
  | { op: "delta"; blockId: string; delta: string }
  | { op: "end"; blockId: string };

// tool_use 的 meta 形状（block_start.meta）。
export type ToolUseMeta = {
  toolCallId: string;
  name: string;
  arguments: unknown;
};
export type ToolResultMeta = {
  toolCallId: string;
  toolName: string;
  isError: boolean;
};

/**
 * content parts（pi-ai 形状）→ Block[]：string 直通、{content:[...]} 包裹解包（tool_execution_end.result 实测形状）。
 * user/assistant 共用（UserMessage.content 允许裸 string 或 parts——pi-ai types.d.ts:283）。
 * image 不进展示（v1 无图片渲染；保留占位防丢序）；未知 part 丢弃。
 */
export const partsToBlocks = (content: unknown): Block[] => {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  if (Array.isArray(content)) {
    const out: Block[] = [];
    for (const p of content as any[]) {
      if (p?.type === "text") out.push({ kind: "text", text: String(p.text ?? "") });
      else if (p?.type === "thinking") out.push({ kind: "thinking", text: String(p.thinking ?? "") });
      else if (p?.type === "toolCall") out.push({ kind: "tool_use", toolCallId: String(p.id ?? ""), name: String(p.name ?? ""), arguments: p.arguments ?? {} });
      else if (p?.type === "image") out.push({ kind: "text", text: "[图片]" });
    }
    return out;
  }
  if (content != null && typeof content === "object" && Array.isArray((content as any).content)) {
    return partsToBlocks((content as any).content);
  }
  return [];
};

/** text blocks 拼接成纯文本（冗余 content 字段 / tool_result 展示文本共用）。 */
export const textOf = (blocks: Block[]): string =>
  blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text).join("");

/** 任意 content → 展示文本：parts 走 partsToBlocks/textOf，其余对象 JSON 化（防御性归一）。 */
export const flattenText = (content: unknown): string => {
  if (typeof content === "string" || Array.isArray(content)) return textOf(partsToBlocks(content));
  if (content != null && typeof content === "object" && Array.isArray((content as any).content)) {
    return flattenText((content as any).content);
  }
  if (content == null) return "";
  try { return JSON.stringify(content); } catch { return String(content); }
};

/**
 * pi NDJSON 事件 → StreamBlock 帧流（#20：spawnPiCore 补解析——thinking/tool_use/tool_result 不再丢弃）。
 * 工厂闭包持有本地 blockId 计数（pi 增量事件无 id）+ 当前开放 text/thinking 块。
 * 输入事件形状（pi 0.83 实证，见二次审核）：
 *   message_update.assistantMessageEvent: text_start/delta/end、thinking_start/delta/end、toolcall_end{toolCall}
 *   tool_execution_end{toolCallId, toolName, result, isError}
 */
export type BlockEmitter = (ev: any) => StreamBlock[];

export const createBlockEmitter = (): BlockEmitter => {
  let n = 0;
  const bid = (): string => `b${++n}`;
  let open: string | null = null; // 当前开放中的 text/thinking 块（pi 串行产出，同时至多一个）

  return (ev) => {
    if (!ev || typeof ev !== "object") return [];
    // assistant 消息内增量（text/thinking 交替；toolcall_end 自包含）
    if (ev.type === "message_update") {
      const d = ev.assistantMessageEvent;
      if (!d) return [];
      if (d.type === "text_start") { open = bid(); return [{ op: "start", blockId: open, kind: "text" }]; }
      if (d.type === "thinking_start") { open = bid(); return [{ op: "start", blockId: open, kind: "thinking" }]; }
      if (d.type === "text_delta" || d.type === "thinking_delta") {
        return open ? [{ op: "delta", blockId: open, delta: String(d.delta ?? "") }] : [];
      }
      if (d.type === "text_end" || d.type === "thinking_end") {
        if (!open) return [];
        const id = open;
        open = null;
        return [{ op: "end", blockId: id }];
      }
      if (d.type === "toolcall_end" && d.toolCall) {
        const tc = d.toolCall;
        const id = typeof tc.id === "string" && tc.id ? tc.id : bid();
        const meta: ToolUseMeta = { toolCallId: id, name: String(tc.name ?? ""), arguments: tc.arguments ?? {} };
        return [
          { op: "start", blockId: id, kind: "tool_use", meta },
          { op: "end", blockId: id },
        ];
      }
      return [];
    }
    // 工具执行结束（一次性出结果；partialResult 流式中间态 v1 不发——计划 Out）
    if (ev.type === "tool_execution_end") {
      const tcId = String(ev.toolCallId ?? "");
      const id = tcId ? `r_${tcId}` : bid();
      const meta: ToolResultMeta = { toolCallId: tcId, toolName: String(ev.toolName ?? ""), isError: ev.isError === true };
      const text = flattenText(ev.result);
      return [
        { op: "start", blockId: id, kind: "tool_result", meta },
        { op: "delta", blockId: id, delta: text },
        { op: "end", blockId: id },
      ];
    }
    return [];
  };
};
