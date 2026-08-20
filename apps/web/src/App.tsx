// 路由表（f2：react-router v7 声明式库模式；f4：admin 嵌入 shell）。
// / = ProtectedRoute > ShellLayout（三区）；/login。admin 子页渲染在 shell 中区
// （Sidebar 复用不卸载——切页只刷中区，f4 用户决定）；URL 沿 f2 的 /admin/* 不变。
import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { useAuth } from "./store/auth";
import { ProtectedRoute } from "./routes/ProtectedRoute";
import { LoginPage } from "./routes/LoginPage";
import { ShellLayout } from "./routes/ShellLayout";
import { ChatPage } from "./routes/ChatPage";
import { FilePreviewPage } from "./routes/FilePreviewPage";

// admin 懒加载（member 不进管理页——不进首屏 bundle）
const AdminUsersPage = lazy(() =>
  import("./routes/admin/UsersPage").then((m) => ({ default: m.AdminUsersPage })),
);
const AdminWorkspacesPage = lazy(() =>
  import("./routes/admin/WorkspacesPage").then((m) => ({ default: m.AdminWorkspacesPage })),
);
const AdminTasksPage = lazy(() =>
  import("./routes/admin/TasksPage").then((m) => ({ default: m.AdminTasksPage })),
);
const AdminWorkflowsPage = lazy(() =>
  import("./routes/admin/WorkflowsPage").then((m) => ({ default: m.AdminWorkflowsPage })),
);

export function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<ShellLayout />}>
            <Route index element={<ChatPage />} />
            <Route path="c/:conversationId" element={<ChatPage />} />
            <Route path="files/:workspaceId/*" element={<FilePreviewPage />} /> {/* #30 产出文件预览 */}
            <Route path="admin" element={<Navigate to="/admin/users" replace />} />
            <Route
              path="admin/users"
              element={
                <Suspense fallback={null}>
                  <AdminUsersPage />
                </Suspense>
              }
            />
            <Route
              path="admin/workspaces"
              element={
                <Suspense fallback={null}>
                  <AdminWorkspacesPage />
                </Suspense>
              }
            />
            <Route
              path="admin/tasks"
              element={
                <Suspense fallback={null}>
                  <AdminTasksPage />
                </Suspense>
              }
            />
            <Route
              path="admin/workflows"
              element={
                <Suspense fallback={null}>
                  <AdminWorkflowsPage />
                </Suspense>
              }
            />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
