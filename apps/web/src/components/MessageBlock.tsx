// MessageBlock（f3-2/ADR-0019）：块渲染器——text/thinking/tool_use(tool_result 折卡)。
// 实时（block 三帧组装）与历史（reader blocks）同构：同一组件、无分支。
// 交互（grill Q7/Q11）：thinking 流式占位「思考中…」→ 终态折叠一行可展开；
// tool_use 默认折叠（图标+摘要），isError 红字露出不折叠。UI 禁 emoji（Phosphor，strokeWidth 1.5）。
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlight } from "../lib/highlight";
import { BLOCK_KIND } from "../lib/blocks";
import {
  BrainIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckSquareIcon,
  TerminalIcon,
  EyeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  WarningIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import type { UIAnyBlock } from "../store/chat";

const IW = 1.5; // 图标线宽全局统一（design 纪律）

// tool_use 摘要：图标 + 一句话（read→读取 path / write→编辑 path / bash→运行 cmd / 其余→工具名）
const toolSummary = (name: string, args: unknown): { icon: typeof EyeIcon; text: string } => {
  const a = (args ?? {}) as Record<string, unknown>;
  const path = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
  const cmd = typeof a.command === "string" ? a.command : "";
  if (/read|view|cat/i.test(name) && path) return { icon: EyeIcon, text: `读取 ${path}` };
  if (/write|edit|patch/i.test(name) && path) return { icon: PencilSimpleIcon, text: `编辑 ${path}` };
  if (/bash|shell|exec/i.test(name)) return { icon: TerminalIcon, text: cmd ? `运行 ${cmd}` : `运行命令` };
  if (/search|web/i.test(name)) return { icon: MagnifyingGlassIcon, text: `搜索 ${String(a.query ?? name)}` };
  return { icon: WrenchIcon, text: name };
};

/** thinking 块：折叠行（流式中显「思考中 N 字」+动画；终态「已思考 N 字」），展开实时看思考文字。 */
export function ThinkingBlock({ block }: { block: Extract<UIAnyBlock, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const streaming = block.streaming === true;
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? <CaretDownIcon size={12} strokeWidth={IW} /> : <CaretRightIcon size={12} strokeWidth={IW} />}
        <BrainIcon size={14} weight="light" strokeWidth={IW} className={streaming ? "animate-pulse" : undefined} />
        <span>
          {streaming
            ? block.text.length > 0
              ? `思考中 ${block.text.length} 字…` // 流式可见进度（非黑盒等待）
              : "思考中…"
            : `已思考 ${block.text.length} 字`}
        </span>
      </button>
      {open && (
        <div className="reveal mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
          {block.text}
          {streaming && <span className="cursor">▍</span>}
        </div>
      )}
    </div>
  );
}

/** tool_use 卡：图标+摘要头；result 折叠在卡内（isError 红字露出）。 */
export function ToolUseBlock({ block }: { block: Extract<UIAnyBlock, { kind: "tool_use" }> }) {
  const [open, setOpen] = useState(false);
  const { icon: Icon, text } = toolSummary(block.name, block.arguments);
  const isError = block.result?.isError === true;
  return (
    <div className="my-1 rounded-md border border-border bg-card text-[13px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-mono text-xs text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? <CaretDownIcon size={12} strokeWidth={IW} /> : <CaretRightIcon size={12} strokeWidth={IW} />}
        <Icon size={14} weight="light" strokeWidth={IW} />
        <span className="truncate">{text}</span>
        {block.result == null && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">运行中…</span>}
        {block.result != null && !isError && (
          <CheckSquareIcon size={14} weight="light" strokeWidth={IW} className="ml-auto shrink-0 text-success" />
        )}
        {isError && <WarningIcon size={14} weight="light" strokeWidth={IW} className="ml-auto shrink-0 text-destructive" />}
      </button>
      {/* 错误摘要永远露出（折叠态也可见） */}
      {isError && !open && (
        <div className="truncate px-2.5 pb-1.5 font-mono text-xs text-destructive">{block.result?.text.slice(0, 200)}</div>
      )}
      {open && block.result != null && (
        <pre className="reveal max-h-64 overflow-auto whitespace-pre-wrap border-t border-border px-2.5 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {block.result.text}
        </pre>
      )}
    </div>
  );
}

/** 代码块：流式（block 未关）纯文本；落定后 shiki 高亮（f3-4——异步、失败退纯文本）。 */
function CodeBlock({ code, lang, streaming }: { code: string; lang?: string; streaming: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (streaming) return; // 流式中不高亮（每 delta 重跑太贵）
    let alive = true;
    void highlight(code, lang).then((h) => {
      if (alive && h) setHtml(h);
    });
    return () => {
      alive = false;
    };
  }, [code, lang, streaming]);
  if (html) return <code className="block" dangerouslySetInnerHTML={{ __html: html }} />;
  // 流式/高亮未落定 fallback：先给代码卡底色（与 shiki 卡视觉连续，不闪裸文本）
  return <code className="block rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{code}</code>;
}

/**
 * 块 key（稳定标识，非位置索引——tool_result 归卡时会从数组移除，索引 key 会串展开态）：
 * 实时块用组装期 blockId（block_end 后保留）；历史块无 blockId → tool_use 用 toolCallId、其余 h+位置
 * （历史是静态列表，位置即稳定身份）。
 */
const blockKey = (b: UIAnyBlock, i: number): string => b.blockId ?? (b.kind === BLOCK_KIND.toolUse ? b.toolCallId : `h${i}`);

/** 单条消息的 blocks 渲染（ChatWindow 调）。 */
export function MessageBlocks({ blocks }: { blocks: UIAnyBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === BLOCK_KIND.text) {
          if (!b.text) return null; // 空文本块（流式 start 未到 delta）不占位
          return (
            <div key={blockKey(b, i)} className="md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // 行内 code 直通；块级 code 走 CodeBlock（shiki 落定后接管）
                  code: ({ className, children, node, ...props }) => {
                    const text = String(children ?? "");
                    // 行内 code（无 language- 类、单行无换行）直通；块级走 CodeBlock
                    const m = /language-(\S+)/.exec(className ?? "");
                    if (!m && !text.includes("\n")) return <code className={className} {...props}>{children}</code>;
                    return <CodeBlock code={text.replace(/\n$/, "")} lang={m?.[1]} streaming={b.streaming === true} />;
                  },
                }}
              >
                {b.text}
              </ReactMarkdown>
            </div>
          );
        }
        if (b.kind === BLOCK_KIND.thinking) return <ThinkingBlock key={blockKey(b, i)} block={b} />;
        if (b.kind === BLOCK_KIND.toolUse) return <ToolUseBlock key={blockKey(b, i)} block={b} />;
        return null; // tool_result 已在组装期折进 tool_use（store/chat）
      })}
    </>
  );
}
