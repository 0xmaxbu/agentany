# 单进程 Hono + React/Vite：闲聊走 SSE、远端客户端走 WS

后端选 **Hono（API + 原生 WS）+ React/Vite 前端**，**单进程**（Hono 同时托管前端构建产物）。鉴权、项目隔离、Pi 编排、computer-use 工具注册都在这一个进程内。传输分两条、各取最简：**闲聊流式**（Pi token → 浏览器）走 **SSE**（单向、浏览器自动重连）；**远端 computer-use 客户端**走 **WebSocket**（双向、承载 JSON-RPC）。

## 备选

- **Next.js**：否。远端客户端的 WS 在 Next 里不够原生（要自定义 server / 独立端口）；Hono 的 WS 一等支持、更顺。
- **统一用 WS 承载闲聊**：否。闲聊本质是单向 token 流，SSE 更简；为"一种传输"把闲聊也塞进 WS 不值。
