// NoAccess（chat-optimize 抽公共件）：admin 页无权限兜底（Users/Workspaces/Tasks 三页复制 ×3 消除）。
import { useNavigate } from "react-router";
import { ShieldWarningIcon } from "@phosphor-icons/react";
import { Button } from "./button";

const IW = 1.5; // 图标线宽全局统一

export function NoAccess() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3">
      <ShieldWarningIcon size={36} weight="light" strokeWidth={IW} className="text-muted-foreground opacity-60" />
      <p className="text-sm text-muted-foreground">无权限：管理页仅管理员可用。</p>
      <Button onClick={() => navigate("/")}>返回对话</Button>
    </div>
  );
}
