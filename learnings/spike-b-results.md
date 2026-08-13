# Spike B · 手搓工作流引擎 — 实测结果

> 关联：`docs/spikes/spike-b-workflow-engine.md`（设计）、ADR 0001/0004/0006、Spike A（`runPi` 已验）
> 环境：macOS darwin · bun 1.3.10 · `bun:sqlite` · 17/17 断言通过
> 产物（throwaway，可删）：`spikes/spike-b/{store,defineWorkflow,runner,workflow,driver,test}.mjs` + `schema.mjs`

## 结论：机制成立 ✅

线性步 + 动态选下一步（含**循环**）+ HITL suspend/resume（**杀进程后跨进程续跑**）+ append-only 持久化，全部跑通，且**零 replay**。

## API 定稿（可直接搬 apps/server/src/workflow/）

```js
defineWorkflow({ id, inputSchema, start })
  .step(id, { async execute(ctx) { return { ...output, __next?: "stepId" } | { __suspend: { payload, resumeSchema } }; } })
  .commit();

// ctx = { input, resumed?, runPi, projectId, runId, signal, log }
// runner：run(wf, store, runId, ctx) / resume(wf, store, runId, resumeData, ctx)
```

- **动态下一步**：execute 返回 `{...output, __next}`；不给 `__next` 走声明顺序（`defaultNext`），给了就跳，**可往回 = 循环**（redirect 示例回 `s1` 并带 `offset+1`，验证循环携带新数据）。
- **suspend/resume（replay-free 两相）**：首跑返回 `{__suspend:{payload,resumeSchema}}`（须廉价无副作用）；resume 时引擎校验 `resumeData` → **重执行同一步**、`ctx.resumed=resumeData` → 走 resume 分支返回正常 `{...output,__next?}`。无 JS 调用栈序列化、无重放。

## 5 判据全过（17 断言）

| 判据 | 结果 |
|---|---|
| 接受路径 s1→review→s2 | ✅ |
| 循环路径（2 条 s1，offset 0→1） | ✅ |
| **杀进程续跑**（两次独立子进程） | ✅ |
| resumeData 校验（坏数据被拒、状态不变、随后合法 resume 仍推进） | ✅ |
| 幂等 resume（重复提交 no-op、日志不增） | ✅ |

## 关键发现（影响实现/理解）

- **A｜HITL 步留 2 条日志**：append-only + replay-free 两相下，一个挂起的步在日志里是 **suspended → completed 两条**（挂起事件 + 续跑完成事件）。「逻辑路径」要按 `status==="completed"` 取，不能数 stepId。这是诚实的可审计记录（能看到何时挂起、用何数据续跑），不是冗余。
- **B｜「杀进程续跑」是 append-only 的免费收益**：run 状态完全由日志派生（`loadState` 只看最后一条），进程无内存态。`start`（进程 A，挂起退出）→ `resume`（进程 B，全新）跨进程推进成功，只因盘上日志在。无需任何「恢复机器」。
- **C｜幂等靠「未挂起即 no-op」**：resume 时若最后一条非 suspended（已续过/已终结/未开始），直接返回当前状态、不重执行、不 append。重复同一 resumeData 天然不产生重复推进。（注：并发 resume 的竞态 spike 未测，prod 需 per-run 锁/resume-token。）
- **D｜校验失败零副作用**：resumeData 不符 resumeSchema 时**先校验后执行**，拒绝即返回，不 append 任何条目、状态不变。坏数据不留垃圾日志。

## 未覆盖（留给后续）

- 真 `runPi` 接入（Spike A 已验，stub 够隔离引擎）。
- `.branch()`/`.parallel()`：当前只有顺序 + 命令式 `__next`（足够覆盖循环/跳步）。
- 工作流调工作流（`await runWorkflow(...)` 另测）。
- 多 suspend / 一步多问（设计允许：resume 分支再返回 `__suspend`；spike 未测）。
- 崩溃恢复（步执行中途崩，残留 `running` 条目）：spike 把它当 failed 报；prod 需「running 条目 + 幂等执行/compensation」策略。
- 并发 resume 竞态、Hono/前端/鉴权接入。

## stub → prod 迁移注记

- `schema.mjs`（手搓）→ **zod**；`validate` → `safeParse`，API 形状不变。
- `store.mjs`（裸 `bun:sqlite`）→ **Drizzle** 包同一份两表 schema（`workflow_runs` + `workflow_run_log`，见 ADR-0004/0006）。
- `stubRunPi` → `apps/server/src/pi/runPi.ts`（Spike A 产出：rpc 子进程驱动 + 沙箱）。
- `driver.mjs`（CLI）→ Hono 路由：`POST /workflows/:id/runs`（start）、`POST /runs/:id/resume`、`GET /runs/:id`（status），SSE 推进步事件。
- `__next` 当前随 output 存进日志、并透传给下一步 input（步骤忽略多余键无碍）；prod 可在 append 前剥离 `__next` 仅作路由用。
