// 三区 shell（f2-3，ADR-0015 chat-centric）：左 Sidebar（ws 分组会话列表）/ 中 ChatPage（Outlet）/
// 右 ContextPanel（可折叠，默认收起）。header 在中区内由 ChatPage 渲染（契约 header .conv，
// 主题切换 + 右栏折叠钮也在 header 右侧——经 context 下传）。
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Outlet } from "react-router";
import { Sidebar } from "../components/Sidebar";
import { ContextPanel } from "../components/ContextPanel";
import { useWorkspace } from "../store/workspace";
import { useTheme } from "../lib/theme";

// header 右侧控制（ChatPage header 消费——ShellLayout 持状态，切会话不丢）
const ShellControlsContext = createContext<ReactNode>(null);

export function useShellControls(): ReactNode {
  return useContext(ShellControlsContext);
}

export function ShellLayout() {
  const [panelOpen, setPanelOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const load = useWorkspace((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  const controls = (
    <div className="flex items-center gap-1">
      <button
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        className="rounded-md border border-border bg-card px-2 py-1 text-xs text-card-foreground hover:opacity-80"
        title="切换主题"
      >
        {theme === "dark" ? "浅色" : "深色"}
      </button>
      <button
        onClick={() => setPanelOpen((v) => !v)}
        className="rounded-md border border-border bg-card px-2 py-1 text-xs text-card-foreground hover:opacity-80"
        title="上下文栏"
      >
        {panelOpen ? "收起" : "上下文"}
      </button>
    </div>
  );

  return (
    <ShellControlsContext.Provider value={controls}>
      <div className="flex h-dvh w-full bg-background text-foreground">
        <Sidebar />
        {/* min-h-0：flex 子项默认 min-height:auto 会随内容撑高——必须显式放开才能让中区内部滚动 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
        {panelOpen && <ContextPanel />}
      </div>
    </ShellControlsContext.Provider>
  );
}
