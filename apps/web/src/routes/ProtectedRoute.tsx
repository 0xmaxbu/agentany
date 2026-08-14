// 路由守卫（f2）：checking 静默（防闪）；unauthenticated → /login；anonymous（dev 放行）/authenticated → 放行。
import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "../store/auth";

export function ProtectedRoute() {
  const status = useAuth((s) => s.status);
  const location = useLocation();
  if (status === "checking") return null;
  if (status === "unauthenticated") return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
