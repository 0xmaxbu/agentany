import { defineConfig } from "@playwright/test";

// E2E：Playwright webServer 起 ① backend（E2E 专用入口，stub runPi）+ ② vite dev（proxy）。
// baseURL = vite dev :5173 → proxy → backend :3000。仅 CLI（@playwright/test），无 MCP。
// webServer.cwd 相对本 config 文件解析（= apps/web）。
const BACKEND_PORT = 3000;
const WEB_PORT = 5173;

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
      command: "bun run dev",
      cwd: ".", // apps/web
      url: `http://127.0.0.1:${WEB_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
