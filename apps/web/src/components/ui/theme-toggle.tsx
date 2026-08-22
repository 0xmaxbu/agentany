// ThemeToggle（chat-optimize 抽公共件）：主题切换图标钮——ShellLayout header 与 admin 页共用
// （原三处文本按钮「浅色/深色」复制粘贴，且无焦点环无图标）。图标+aria-label+title 三保险。
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useTheme } from "../../lib/theme";
import { Button } from "./button";

const IW = 1.5; // 图标线宽全局统一

export function ThemeToggle() {
  const [theme, set] = useTheme();
  const dark = theme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => set(dark ? "light" : "dark")}
      aria-label={dark ? "切换到浅色主题" : "切换到深色主题"}
      title={dark ? "浅色" : "深色"}
    >
      {dark ? <SunIcon size={16} strokeWidth={IW} /> : <MoonIcon size={16} strokeWidth={IW} />}
    </Button>
  );
}
