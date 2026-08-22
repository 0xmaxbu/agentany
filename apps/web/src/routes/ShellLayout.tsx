// 三区 shell（f2-3，ADR-0015 chat-centric）：左 Sidebar（ws 分组会话列表）/ 中 ChatPage（Outlet）/
// 右 ContextPanel（可折叠，默认收起）。header 在中区内由 ChatPage 渲染（契约 header .conv，
// 主题切换 + 右栏折叠钮也在 header 右侧——经 context 下传）。
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { ArrowLineRightIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { Sidebar } from "../components/Sidebar";
import { ContextPanel } from "../components/ContextPanel";
import { useWorkspace } from "../store/workspace";
import { Button } from "../components/ui/button";
import { ThemeToggle } from "../components/ui/theme-toggle";

const IW = 1.5; // 图标线宽全局统一

// header 右侧控制（ChatPage header 消费——ShellLayout 持状态，切会话不丢）
const ShellControlsContext = createContext<ReactNode>(null);

export function useShellControls(): ReactNode {
  return useContext(ShellControlsContext);
}

export function ShellLayout() {
  const [panelOpen, setPanelOpen] = useState(false);
  const load = useWorkspace((s) => s.load);
  const adminMode = useLocation().pathname.startsWith("/admin"); // Sidebar/右栏按此切态（f4）

  useEffect(() => {
    void load();
  }, [load]);

  const controls = (
    <div className="flex items-center gap-0.5">
      <ThemeToggle />
      <Button
        variant="ghost"
        size="sm"
        className="gap-1 text-xs"
        onClick={() => setPanelOpen((v) => !v)}
        aria-label={panelOpen ? "收起上下文栏" : "展开上下文栏"}
        title={panelOpen ? "收起上下文" : "上下文"}
      >
        {panelOpen ? (
          <ArrowLineRightIcon size={15} strokeWidth={IW} />
        ) : (
          <SidebarSimpleIcon size={15} strokeWidth={IW} />
        )}
        {panelOpen ? "收起" : "上下文"}
      </Button>
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
        {/* admin 态强制隐藏右栏（chat 上下文与管理语境无关）；panelOpen 状态保留，回 chat 恢复 */}
        {!adminMode && panelOpen && <ContextPanel />}
      </div>
    </ShellControlsContext.Provider>
  );
}
