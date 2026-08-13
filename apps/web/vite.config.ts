import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev：proxy 到后端（同源、免 CORS）。prod 经反代或服务端托管。
const BACKEND = process.env.AGENTANY_BACKEND ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true, // E2E 依赖固定 5173
    proxy: {
      "/conversations": BACKEND,
      "/health": BACKEND,
      "/workflows": BACKEND,
      "/runs": BACKEND,
      "/feedback": BACKEND,
    },
  },
});
