// 轻量 Dialog（f4）：遮罩 + Esc/点外关闭。不引 Radix（f2 手写 ui 惯例；Radix 待真正需要无障碍焦点管理再进）。
import { useEffect, type ReactNode } from "react";

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose} data-testid="dialog-backdrop">
      <div
        className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {children}
      </div>
    </div>
  );
}
