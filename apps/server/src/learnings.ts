// 经验提取（ADR-0008 持续学习闭环）。后期定时任务；现在留桩 + 数据契约。
//
// 数据契约（已就位，不依赖本桩实现）：
//   - 过程 = 执行的 pi session 文件（workflow_run → session-id 派生自 runId；路径 data/projects/<projectId>/pi-sessions/<sessionId>）。
//   - 反馈 = ① feedback 表（targetKind/targetId 多态，事后评分/批注）；② 流程内反馈 = workflow_run_logs.output / resumeData
//     （工作流步产出里带的反馈字段，如 brand-strategy select-angles 的 feedback，由 runner appendLog 落盘）。
//   - 提取源（ADR-0008 分两期）：前期扫 run 日志（流程内反馈在其中）+ feedback 表 + pi session；后期数据量/结构需要时再建专用学习表。
//
// 后期实现：定时任务遍历已完成的执行 → LLM 读「pi session 过程 + 反馈」→ 蒸馏可复用经验 →
//   append 到 skills/<name>/experience.md（append-only，不碰核心方法论）+ 审计写 learnings/<topic>-<date>.md。

export interface ExtractionTarget {
  targetKind: string; // workflow_run | chat | …
  targetId: string; // runId / conversationId / …
}

export async function extractLearnings(_target: ExtractionTarget): Promise<void> {
  // TODO(后期)：见文件头注释。
  throw new Error(
    `extractLearnings not implemented yet (ADR-0008 后期): ${_target.targetKind}/${_target.targetId}`
  );
}
