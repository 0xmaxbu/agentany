# 0034 - 设备客户端独立仓库 + `@agentany/ws-protocol` 协议包下沉

日期：2026-08-20（grill-with-docs grilling 定稿，Q1/Q9）

## 状态

已接受（设计意图；客户端仓库待建档）

## 背景

ADR-0033 建成了服务端 remote 机制（device-login、WS、preflight、tool 转发、文件回传、授权），但**可运行的设备客户端不存在**——唯一"客户端"是测试用的 `FakeDevice`。补全它是个大工程：Tauri 壳 + 三平台 native 桥（macOS Swift / Windows·Linux Rust）+ 浏览器 CDP 适配 + WS 客户端 + 本地授权 UX。塞进本 monorepo 的 `apps/` 会与 hyper-workflow（服务器为主）纠缠过深；且服务器与客户端都要消费同一套 WS 协议类型，双份真相必然漂移。

## 决策

**D1 · 客户端独立仓库**：设备客户端（Tauri 应用 + native 桥 + 浏览器适配层 + WS 客户端 + 本地授权 UX）整体放入独立 git 仓库。hyper-workflow 保持服务器为主，二者经协议包对接。

**D2 · 协议包下沉 `@agentany/ws-protocol`**：从 hyper-workflow 抽出 `tool_call / tool_result / check_environment / env_report / env_remediated / ping / pong` 的消息类型、枚举与可序列化 schema，放**客户端仓库** `packages/ws-protocol` 作类型真相源；hyper-workflow 服务端经 git/npm 依赖消费它。改协议 = 改一处；服务端现有 seam 测试（`FakeDevice`）继续作行为契约锚。

**D3 · 薄执行器定位**：客户端不感知 run / 工作流 / nonce——只维持 WS 连接（心跳/重连/重验 token/顶号语义）、应答 `check_environment`、按 `tool_call` 的 `tool`+`args`+`schema` 在设备本地执行并回 `tool_result`（产物走 `POST /files/device-upload`）。整体执行逻辑分布在各工具执行器，客户端本体保持转发薄。

## 负决策

- **不把客户端塞进 hyper-workflow `apps/`**：服务器与客户端发布周期、信任面、测试环境不同。
- **不做双份协议类型（复制一份各自维护）**：由 e2e 对齐只会漂移，协议演进必须单一入口。

## 后果

- 服务端改动面：`apps/server/src/device/*`、`tool-registry.ts` 的类型改为从 `@agentany/ws-protocol` 导入（抽取 + 一版依赖接入）。
- 依赖方向：hyper-workflow → @agentany/ws-protocol（客户端仓库或独立发布），客户端仓库内部 packages 为主。
- 未来第三方客户端（同一协议的其他实现）获得现成类型真相源。

## 关联

ADR-0033（服务端协议与四表）、0002（遥控 computer-use 的桥、入网层复用）。本文档藏于服务端仓库，客户端建档时把 D1/D2 意向带过去。