// shiki 懒加载高亮（f3-4/ADR-0019）：dynamic import + createHighlighter 单语言按需注册。
// 流式期间不高亮（成本高）——block_end 落定后调 highlight()；首用延迟换 bundle 体积（不进首屏）。
import type { Highlighter } from "shiki";

let highlighter: Highlighter | null = null;
let loading: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

// 常用语言映射（未知语言回退 ts）；json/ts/bash 起手注册
const ALIAS: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash", tsx: "tsx", jsx: "tsx",
  javascript: "js", typescript: "ts", py: "python", rb: "ruby",
};

const langOf = (lang: string | undefined): string => {
  const l = (lang ?? "").toLowerCase();
  return l ? (ALIAS[l] ?? l) : "ts"; // 空语言（无标注代码块）回退 ts
};

const getHighlighter = async (lang: string): Promise<Highlighter> => {
  if (!highlighter) {
    // 双主题（chat-optimize）：light 内联 + --shiki-dark 变量，深模经 styles.css 覆盖
    loading ??= import("shiki").then((m) =>
      m.createHighlighter({ themes: ["github-light-default", "github-dark-default"], langs: [lang] }),
    );
    highlighter = await loading;
  }
  if (!loadedLangs.has(lang)) {
    await highlighter.loadLanguage(lang as never);
    loadedLangs.add(lang);
  }
  return highlighter;
};

/** 高亮代码 → HTML（shiki themed）。语言未注册/加载失败 → null（调用方退回纯文本）。 */
export async function highlight(code: string, lang?: string): Promise<string | null> {
  try {
    const h = await getHighlighter(langOf(lang));
    return h.codeToHtml(code, {
      lang: langOf(lang),
      themes: { light: "github-light-default", dark: "github-dark-default" },
      defaultColor: "light",
    });
  } catch {
    return null; // 未知语言/加载失败——不阻塞渲染
  }
}
