# 工作流经验提取机制（ADR-0008 落地说明）

> 关联：`docs/adr/0008-continuous-learning-loop.md`。本文件说明数据契约 + 后期 job 的实现接口，**job 本身后期才建**（现在留 `extractLearnings` 桩）。

## 闭环

```
每次 agent 执行（workflow_run / chat）
  → 过程记录 = pi session 文件（自动存盘，按 session-id 定位）
  → 用户反馈 = feedback 表（多态 targetKind/targetId）
  → [后期：定时 job] LLM 读「pi session 过程 + 反馈」→ 蒸馏可复用经验
  → append 到 skills/<name>/experience.md（append-only，agent 即时受益）
  → 审计写 learnings/<topic>-<date>.md
```

## 数据契约（已就位）

- **过程**：pi session 文件。workflow_run 的 session-id = `run-<runId>`，路径 = `data/projects/<projectId>/pi-sessions/run-<runId>`。runPi 已传 `--session-id`+`--session-dir`、不传 `--no-session`，故 pi 自动存盘。
- **反馈**：`feedback(targetKind, targetId, text, rating?, createdAt)` 表 + `POST/GET /feedback/:targetKind/:targetId`。`targetKind`：现在 `workflow_run`，后期 `chat`。

## 桩接口

`apps/server/src/learnings.ts`：
```ts
extractLearnings({ targetKind, targetId }): Promise<void>  // 现在抛 not implemented
```

## 后期 job 实现步骤（填桩时）

1. 遍历已完成的执行（workflow_runs ∪ conversations）+ 各自 pi session + feedback。
2. LLM 蒸馏「可复用经验」（洞察 / 适用场景 / 证据）。
3. **append** 到 `skills/<对应 workflow 或 topic>/experience.md`（不碰 SKILL.md 核心方法论，防 LLM 劣化）。
4. 审计写 `learnings/<topic>-<date>.md`（frontmatter: source={targetKind,targetId}、extractedAt）。
5. 周期性人工 review `experience.md`，把高价值经验并进 SKILL.md 核心（可选）。

## 未覆盖

- chat 侧执行（chat 模块 defer；feedback 表已 chat-ready）。
- 定时调度（cron）本身。
- 全量 session 的隐私/存储清理策略（待定）。
