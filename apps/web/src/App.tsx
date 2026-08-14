// 路由表（f2：react-router v7 声明式库模式）。
// / = ProtectedRoute > ShellLayout（三区）；/login；/admin（f4 占位）。
import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { useAuth } from "./store/auth";
import { ProtectedRoute } from "./routes/ProtectedRoute";
import { LoginPage } from "./routes/LoginPage";
import { ShellLayout } from "./routes/ShellLayout";
import { ChatPage } from "./routes/ChatPage";

// admin 懒加载（f4 才有内容——不进首屏 bundle）
const AdminPage = lazy(() =>
  import("./routes/AdminPage").then((m) => ({ default: m.AdminPage })),
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
          </Route>
          <Route
            path="/admin/*"
            element={
              <Suspense fallback={null}>
                <AdminPage />
              </Suspense>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
