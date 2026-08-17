// ticket #17：每轮 system prompt 组合（纯函数）。turn.ts 取数据（PROJECT.md / store / listWorkflows）后调此。
// 返 string[]（每段一个元素，pi --append-system-prompt 可多次）：
// [项目背景] + [工作流目录] + [挂起工作流]×N + [待处理提问]×N（#16 格式）。空块省略。
// CHAT_SYSTEM_PROMPT（角色+工具清单）由 turn.ts 在前prepend，不在本函数。

export interface WorkflowInfo {
  id: string;
  name?: string;
  description?: string;
  inputSchema?: unknown;
}
export interface SuspendedRunInfo {
  runId: string;
  workflowId: string;
  stepId: string;
  payload: unknown;
  resumeSchema: unknown;
}
export interface PendingAsk {
  runId: string | null; // null=自主卡（无 resume 语义——compose 侧走 answer_question 引导分支）
  questionId: number; // 自主卡收口键（answer_question 用；run 绑定卡用 runId resume）
  prompt: string;
  options: string[];
  resumeSchema: unknown;
}
export interface PromptParts {
  projectDoc: string;
  workflows: WorkflowInfo[];
  suspendedRuns: SuspendedRunInfo[];
  pendingAsks: PendingAsk[];
  /** #35 经验注入段（collectExperience 产出：global 全会话 + member 按会话成员）。空数组=无经验文件，省略。 */
  experience?: string[];
}

export function composeSystemPrompt(p: PromptParts): string[] {
  const out: string[] = [];
  out.push(`[项目背景]\n${p.projectDoc}`);
  // #35 经验段紧跟项目背景（都属「做事方式」上下文，先于目录/挂起等动态态）
  out.push(...(p.experience ?? []));

  if (p.workflows.length) {
    const lines = p.workflows
      .map((w) => `- ${w.id}${w.name ? `: ${w.name}` : ""}${w.description ? ` — ${w.description}` : ""}（inputSchema: ${JSON.stringify(w.inputSchema ?? {})}）`)
      .join("\n");
    out.push(`[工作流目录] 可用工作流（start_workflow 用）：\n${lines}`);
  }

  for (const r of p.suspendedRuns) {
    out.push(
      `[挂起工作流] run ${r.runId}（${r.workflowId}）挂起于步骤「${r.stepId}」，等待续跑。\npayload: ${JSON.stringify(r.payload)}\n续跑契约: ${JSON.stringify(r.resumeSchema)}`,
    );
  }

  // #16 pending ask 判答格式（run 绑定分支迁自 turn.ts，逐字保留——turn-inline 内容断言依赖）；
  // 自主卡（runId null，决策 10 修订）：打字答案经 pi 归一化后 answer_question 落卡（对应 resume_workflow）。
  for (const q of p.pendingAsks) {
    out.push(q.runId
      ? `[待处理提问] 工作流 ${q.runId} 正在等待用户决策。\n提问：${q.prompt}\n选项：${q.options.join(" / ")}\n续跑契约：${JSON.stringify(q.resumeSchema)}\n若用户本次消息是对此提问的回答，请将回答归一化为符合续跑契约的对象，并调用 resume_workflow("${q.runId}", resumeData)。若无关，正常回应用户。`
      : `[待处理提问] 澄清（你此前向用户提出的问题，不绑定工作流）。\n提问：${q.prompt}\n选项：${q.options.join(" / ")}\n若用户本次消息是对此提问的回答，请将回答归一化为简洁结构（或保留原文），并调用 answer_question(${q.questionId}, answer) 落卡，再据此继续对话。若无关，正常回应用户。`);
  }

  return out;
}
