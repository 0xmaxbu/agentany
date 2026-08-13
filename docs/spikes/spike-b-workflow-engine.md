# Spike B — 手搓工作流引擎（defineWorkflow + step + 动态 next + suspend/resume + 日志）

> 状态：**已跑通 ✅**（17/17 断言，见 `learnings/spike-b-results.md`）· 关联 ADR 0001/0004/0006、Spike A（`runPi` 已验）
> 目标：证明手搓工作流引擎能跑通「线性步 + 动态选下一步（含循环）+ HITL suspend/resume（**杀进程后 resume**）+ 持久化」，且**不引入 replay 复杂度**。

## 设计决策（已定，经连续性思考推理）

- **(A) 步边界 HITL**：choose/ask 是**独立 step**（持久化边界必要 + BPMN User Task / SFN Human state 惯例），**不塞进 execute**（避免 JS 不可序列化调用栈带来的 replay 机器）。
- **动态下一步（命令式）**：execute 返回 `{...output, __next?: stepId}`；默认沿链；给 `__next` 就跳，**可往回 = 循环**。
- **append-only 执行日志**：每次步执行追加 `{stepId, output, status, ts}`；"当前"= 最后一条；循环重跑 = 再追加一条（无幂等坑）；suspend/resume 都是日志条目。run 状态由日志派生。
- **suspend/resume（replay-free 两相）**：execute 经 ctx 拿 `resumed`。
  - 首跑（`resumed=undefined`）：返回 `{__suspend:{payload, resumeSchema}}` —— **此分支须廉价、无副作用**（不调 runPi；要 LLM 就拆到前一步）。
  - resume：引擎校验 resumeData → **再调一次 execute**、`ctx.resumed=resumeData` → execute 走 resume 分支返回 `{...output, __next?}`。
  - 无重放、无调用栈序列化。**一步最多一次 suspend**（多问 = 多步）。

## API

```ts
defineWorkflow({ id, inputSchema, outputSchema })
  .step(id, {
    outputSchema,
    execute: async (ctx) => ({ ...output, __next?: "stepId" }),      // 普通/终结步
    // 或 HITL 步：首跑返回 __suspend，resume 走 ctx.resumed 分支
  })
  .commit();

// ctx = { input, resumed?, runPi, projectId, runId, signal, log }
// HITL 步示例（含循环）
.step("review", {
  execute: async ({ input, resumed }) => {
    if (resumed) {
      return { ...resumed, __next: resumed.decision === "redirect" ? "research" : undefined };
    }
    return { __suspend: { payload: { notes: input.notes }, resumeSchema: z.object({ decision: z.enum(["accept","redirect"]), focus: z.string().optional() }) } };
  },
})
```

## run 状态（Drizzle，SQLite）

- `workflow_runs(runId, workflowId, projectId, status, input, createdAt, updatedAt)`
- `workflow_run_log(id, runId, seq, stepId, output(json), status(running|completed|suspended|failed), suspendPayload, resumeSchema(json), ts)`
- run 状态 = 日志派生（最后一条决定 current/next）。

## 成功判据（最小纵切，3 步合成工作流，**stub 代替 runPi** 以隔离引擎）

- `s1`：产出值（可带 offset 输入）。
- `review`（HITL）：suspend 问"accept / redirect(+offset)"；resume 据 `decision` → `__next:"s1"`（循环、带新 offset）或 `undefined`（进 `s2`）。
- `s2`：终结。

验证：
- ✅ **接受路径**：s1→review→s2，`completed`。
- ✅ **循环路径**：s1→review(redirect)→s1(带 offset)→review(accept)→s2；日志含 **2 条 s1**。
- ✅ **杀进程续跑**：review suspend 后**杀服务进程**→重启→`resume(runId,data)`→正确推进到 s2（日志持久化生效，这是 append-only 的核心收益）。
- ✅ **resumeData 校验**：坏数据（不符 resumeSchema）被拒、不改状态。
- ✅ **幂等 resume**：同一 resumeData 重复提交不产生重复推进。

## 不做（留给后续）
- 真 `runPi` 接入（Spike A 已验）；Hono/前端/鉴权；`.branch()`/`.parallel()`；工作流调工作流（最小 `await runWorkflow` 另测）；多 suspend/步。

## 待开跑前确认
- **stub 还是真 runPi**？➡️ 推荐 **stub**（隔离引擎机制；runPi 已在 Spike A 验过）。—— **已采用 stub，17/17 通过。**

## 实测补充发现（见 results）
- **HITL 步 = 2 条日志**（suspended + completed）：append-only + 两相的自然结果。「逻辑路径」按 `status==="completed"` 取。
- **杀进程续跑零成本**：run 状态纯由日志派生，跨进程 resume 成立，无需恢复机器。
- **幂等**：resume 时非 suspended 即 no-op（不重执行、不 append）。
