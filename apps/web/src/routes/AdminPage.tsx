// 管理页占位（f4 实装：用户 + workspace 管理）。f2 只留路由骨架（ADR-0015 独立管理路由）。
export function AdminPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-background text-foreground">
      <h1 className="text-xl font-semibold">管理</h1>
      <p className="text-sm text-muted-foreground">管理功能将在 f4 提供（用户 / 工作空间）。</p>
    </div>
  );
}
