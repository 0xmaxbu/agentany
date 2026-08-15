import { defineConfig } from "@playwright/test";

// E2E：Playwright webServer 起 ① backend（E2E 专用入口，stub runPi）+ ② vite dev（proxy）。
// 端口与 dev:local（3001/3299/5173）完全隔离——并行互不干扰（dev:local vite 占 5173，e2e 用 5174）。
// baseURL = e2e vite :5174 → proxy → e2e backend :3000。仅 CLI（@playwright/test），无 MCP。
// webServer.cwd 相对本 config 文件解析（= apps/web）。
const BACKEND_PORT = 3000;
const WEB_PORT = 5174;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // f2 后会话列表=服务端真相（GET /conversations 按 userId=dev-user 过滤）——并行 worker
  // 冒充同一 dev-user，列表/SSE 互相污染（localStorage 时代每 context 隔离）。串行消除变量。
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    channel: "chrome", // 用系统 Google Chrome，免下载 chromium（无网络依赖）
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: `rm -rf /tmp/agentany-e2e && DATA_DIR=/tmp/agentany-e2e PORT=${BACKEND_PORT} bun run apps/server/src/e2e-entry.ts`,
      cwd: "../..", // 仓库根（相对 config）
      url: `http://127.0.0.1:${BACKEND_PORT}/health`, // Playwright 1.62：port/url 二选一（同给会报错）
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `bun run dev -- --port ${WEB_PORT} --strictPort`,
      cwd: ".", // apps/web（--strictPort：5174 被占即报错，不静默漂移端口）
      url: `http://127.0.0.1:${WEB_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
