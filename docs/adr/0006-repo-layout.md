# 仓库结构：Bun monorepo（apps/server + apps/web）

```
agentany/
├── apps/
│   ├── server/                     # Hono 单进程后端（托管 web 产物）
│   │   └── src/
│   │       ├── auth/               # bcrypt 账号 + 会话 + 首管理员 bootstrap
│   │       ├── projects/           # 项目 + 成员关系（隔离）
│   │       ├── chat/               # 闲聊：每会话 rpc Pi，SSE 流式
│   │       ├── pi/                 # Pi 执行层（Spike A 产出）
│   │       │   ├── runPi.ts  sandbox.ts  sanitize.ts  session.ts
│   │       ├── workflow/           # 手搓工作流引擎（Spike B）
│   │       │   ├── defineWorkflow.ts  run.ts  store.ts
│   │       ├── capabilities/       # 能力菜单 = Pi get_commands(skills) ∪ coded workflows
│   │       ├── remote/             # (v2) WS JSON-RPC + computer-use 桥
│   │       ├── audit/  db/(Drizzle: SQLite→PG)  routes/
│   │   └── workflows/              # coded 工作流
│   │       ├── brand-research.ts          # 调研（全自动）
│   │       └── brand-strategy-analysis.ts # 战略分析（HITL）
│   └── web/                        # React/Vite 前端（chat UI、项目/会话、能力菜单、上传）
├── skills/                         # Pi skills（标准发现，见 ADR-0005）
│   ├── document-tools/  brand-strategy-research/
│   └── tavily-search/{SKILL.md, extensions/}   # 独立 skill（自带 web-search 工具扩展）
├── tools/                          # 既有 CLI（pdf2docx/docx2pdf/anydoc…）
├── data/   (gitignored)            # 运行时
│   ├── db.sqlite
│   ├── projects/<projectId>/{uploads,reports,pi-sessions}/
│   └── archives/                   # 对话完整归档（四段式盘占）
├── docs/{adr,spikes,agents}/   learnings/   spikes/   CONTEXT.md   CLAUDE.md
```

## 决策

- **Bun workspaces monorepo**：`apps/server`（Hono）+ `apps/web`（React/Vite）。Hono 进程同时托管前端构建产物 = 单进程（ADR-0003）。选 Bun：内网工具、Hono 原生、冷启动/依赖快；Pi 作为子进程与运行时无关。
- **coded 工作流**：`apps/server/src/workflows/<name>.ts`（引擎在服务端跑）。**规格 `workflows/*.md` 已废除**——ADR-0033 D1 统一真身：定义以代码为唯一真身（根 md 为衍生物、零运行时引用、长期漂移，已删）。
- **项目级数据隔离**：`data/projects/<id>/{uploads,reports,pi-sessions}/`；Pi 子进程 `--cwd`=项目工作区（沙箱锁此）、`--session-dir`=项目内 `pi-sessions/`（会话项目级、不串）。DB 单文件 `data/db.sqlite`（Drizzle，后续换 PG，ADR-0004）。对话归档 `data/archives/`。
- **skills**：仓库 `skills/<name>/`；**`tavily-search` 独立**（不并入 brand-strategy-research）。运行时按 ADR-0005：**只读挂载进沙箱**（prod bwrap `--ro-bind repo/skills → workspace/.pi/skills` 走标准发现；dev `--skill <repo-path>`），不用 symlink。
- **既有 `tools/`**（CLI 助手）保留原位。

## 后果

- 工作流定义**只有代码一份真身**（`apps/server/src/workflows/`）；规格/红线/测试指向沉淀于 `docs/adr/`、`CONTEXT.md`、`skills/{name}/SKILL.md`。
- `data/` 整个 gitignored；新机器 clone 后由服务首次启动建（含首管理员 bootstrap）。
- skill 改动只需更新仓库 `skills/`，所有项目自动生效（标准发现 + ro-bind 指向仓库）。
