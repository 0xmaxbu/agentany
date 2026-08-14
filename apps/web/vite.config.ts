import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// dev：proxy 到后端（同源、免 CORS）。prod 经反代或服务端托管。
const BACKEND = process.env.AGENTANY_BACKEND ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true, // E2E 依赖固定 5173
    proxy: {
      "/conversations": BACKEND,
      "/approvals": BACKEND, // #18 审批门（POST /approvals/:id/decide）
      "/health": BACKEND,
      "/workflows": BACKEND,
      "/runs": BACKEND,
      "/feedback": BACKEND,
      "/auth": BACKEND, // f2 登录（POST /auth/login / logout）
      "/me": BACKEND, // f2 身份探测（GET /me——dev 阀未设时 200 匿名直进）
      "/users": BACKEND, // f4 管理页预留
      "/workspaces": BACKEND, // f2 会话列表按 ws 分组（GET /workspaces）
    },
  },
});
