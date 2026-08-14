// 主题切换（f2/ADR-0016 双模）：class 策略写 documentElement；localStorage 记忆；缺省跟系统。
import { useEffect, useState } from "react";

const THEME_KEY = "agentany.theme";

export type Theme = "light" | "dark";

const apply = (t: Theme): void => {
  document.documentElement.classList.toggle("dark", t === "dark");
};

export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* 忽略 */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 切主题（写 class + 记忆）。 */
export function setTheme(t: Theme): void {
  apply(t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* 忽略 */
  }
}

/** hook：初值来自存储/系统，首次 effect 前先同步 class（防闪可在 index.html 内联——v2）。 */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(initialTheme);
  useEffect(() => {
    apply(theme);
  }, [theme]);
  return [theme, (t) => {
    set(t);
    setTheme(t);
  }];
}
