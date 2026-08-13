# Pi provider key 解析器与 cwd（关键坑）

**日期**：2026-08-12　**置信度**：HIGH（pi 自身 errorMessage + 改 resolver 实证复现/修复）

## 现象
`runPi`/`runPiStream` 从**仓库根 cwd** 调 pi 正常（流式 `text_delta`、回 "PONG"）；从**任意子目录 cwd**（如 `data/projects/<id>/workspace`、`apps/server`）调 pi → turn 完整跑完但 **0 个 `message_update`、助手内容空 `[]`、exit 0、无 error event**。极像"模型空回复"，极具迷惑性。

## 根因（pi 自己的报错）
`~/.pi/agent/models.json` 里自定义 "go" provider：
```json
"apiKey": "!grep '^GO_API_KEY=' .env | cut -d= -f2- | tr -d '\r\\n'"
```
`!` 前缀 = pi 把该串当 **shell 命令**执行来解析密钥；命令里 `.env` 是**相对 cwd** 的。
- cwd=仓库根 → 有 `.env` → 解析到 key → 正常。
- cwd=项目工作区/子目录 → 无 `.env` → `grep` 空 → **鉴权失败** → provider 返回空消息（`stopReason:"error"`、`errorMessage:"API key auth failed for provider go: Failed to resolve API key ... from shell command: grep '^GO_API_KEY=' .env ..."`）。

与 CLAUDE.md / .git / skills / `-a` / childEnv 白名单**全无关**——只是"provider 密钥命令读 cwd 的 .env"。

## 影响（cross-cutting）
**所有 cwd=项目工作区的 pi 调用都中招**——不止 chat 切片①：
- chat turn（`makeRunPiStream`，cwd=`projectWorkspacePath`）。
- workflow run 的 agent 步（`makeRunPi`，同 cwd）——**现有 brand-research/strategy 工作流从项目工作区跑真 pi 同样会空退**；现有测试用 stub `runPiFactory` 没暴露。

## 修复（实证）
把 resolver 改成 **cwd 无关**（临时改 `~/.pi/agent/models.json` 实测：工作区 cwd → `delta=2, "PONG"`，全通）：
```json
"apiKey": "!printenv GO_API_KEY"
```
`runPi` 的 `childEnv()` 白名单已放行 `GO_` 前缀，`config.ts` 已把仓库 `.env` 的 `GO_API_KEY` 载入 `process.env` → pi 子进程 env 有 `GO_API_KEY` → `printenv` 取到。**cwd 无关、不往工作区复制密钥**（符合 ADR-0011 A4 方向）。

权衡：用户直接在 shell 跑 `pi`（不经服务）时，需 `export GO_API_KEY` 或 `source .env`；否则 resolver 落空。若想兼顾，resolver 可写 `!printenv GO_API_KEY || grep '^GO_API_KEY=' .env | cut -d= -f2- | tr -d '\r\n'`（先 env 后 cwd-.env 兜底）。

## 这是 pi 全局配置，非仓库代码
- 改的是用户 `~/.pi/agent/models.json`，**不是 repo bug**；需用户拍板（影响其所有 pi 用法）。
- 仓库侧的应对：文档化"provider 密钥解析器须 cwd 无关"；可考虑提供 `scripts/fix-pi-provider.mjs` 辅助，但 **绝不**自动改用户 `~/` 配置。

## 关联
ADR-0009（chat，cwd=项目工作区）、ADR-0005/0006（Pi 加载/项目隔离）、ADR-0011（A4 信任材料不进 pi 可读空间）、`SECURITY.md` 已知局限 #2（密钥仍在 pi 可达 env）。
