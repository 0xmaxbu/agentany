/**
 * chat-bridge 扩展的纯逻辑（与 pi/typebox 解耦 → 可在服务端 bun 测试）。
 * 镜像 skills/tavily-search/extensions/tavily-core.ts 的分层：core 纯、extension 薄壳。
 *
 * bridge 坐标（url + nonce）由 chat turn 每轮经 env 注入 pi 子进程（AGENTANY_BRIDGE_URL/NONCE）。
 */

export interface BridgeEnv {
  url: string;
  nonce: string;
}

/** 从 env 读 bridge 坐标。缺任一 → null（调用方据此报错）。env 必传（本模块不引用 process 全局，保持与 pi/服务端双端可测）。 */
export function readBridgeEnv(env: Record<string, string | undefined>): BridgeEnv | null {
  const url = env.AGENTANY_BRIDGE_URL;
  const nonce = env.AGENTANY_BRIDGE_NONCE;
  return url && nonce ? { url, nonce } : null;
}

/** GET <url>/ping（Bearer nonce）→ 文本摘要（status + body）。非 200 也如实返回，不抛。 */
export async function pingBridge(env: BridgeEnv): Promise<string> {
  const r = await fetch(`${env.url}/ping`, { headers: { authorization: `Bearer ${env.nonce}` } });
  return await textResult(r, "bridge ping");
}

// 通用：把 Response 摘成 `<prefix>: <status> <body>`（body 优先 JSON，否则 text）。
async function textResult(r: Response, prefix: string): Promise<string> {
  let body = "";
  try {
    body = JSON.stringify(await r.json());
  } catch {
    body = await r.text().catch(() => "");
  }
  return `${prefix}: ${r.status} ${body}`;
}

/** POST <url>/run/start（Bearer nonce）→ 启动工作流（后台 subagent）。返 status + body。 */
export async function startWorkflow(env: BridgeEnv, workflowId: string, input: unknown): Promise<string> {
  const r = await fetch(`${env.url}/run/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ workflowId, input: input ?? {} }),
  });
  return textResult(r, `start_workflow ${workflowId}`);
}

/** GET <url>/run/read?runId=（Bearer nonce）→ 读 run 状态/步骤/最新输出。返 status + body。 */
export async function readRun(env: BridgeEnv, runId: string): Promise<string> {
  const r = await fetch(`${env.url}/run/read?runId=${encodeURIComponent(runId)}`, {
    headers: { authorization: `Bearer ${env.nonce}` },
  });
  return textResult(r, `read_run ${runId}`);
}

/** POST <url>/ask_user（Bearer nonce）→ 异步建自主提问卡（runId null，无 resume 语义；ADR-0025 决策 7 修订——
 *  run 绑定卡由引擎挂起时直建，bridge 带 runId 必 400）。立即返 {asked}，不阻塞 turn。返 status + body。 */
export async function askUser(env: BridgeEnv, p: { prompt: string; options: string[]; resumeSchema?: unknown; multiple?: boolean }): Promise<string> {
  const r = await fetch(`${env.url}/ask_user`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.nonce}`, "content-type": "application/json" },
    body: JSON.stringify(p),
  });
  return textResult(r, `ask_user ${p.prompt.slice(0, 20)}`);
}

/** POST <url>/ask_answer（Bearer nonce）→ pi 归一化答案落自主卡（决策 10 修订：回答即 solved）。返 status + body。 */
export async function answerQuestion(env: BridgeEnv, questionId: number, answer: unknown): Promise<string> {
  const r = await fetch(`${env.url}/ask_answer`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ questionId, answer }),
  });
  return textResult(r, `answer_question ${questionId}`);
}

/** POST <url>/run/resume（Bearer nonce）→ 用归一化答案续跑挂起的 run。返 status + body。 */
export async function resumeWorkflow(env: BridgeEnv, runId: string, resumeData: unknown): Promise<string> {
  const r = await fetch(`${env.url}/run/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ runId, resumeData }),
  });
  return textResult(r, `resume_workflow ${runId}`);
}

// ── #28 定时任务工具（/task/*）──

/** POST /task/create：校验（频率下限等）+ 出任务卡（用户确认后服务端直建）。422/403=可解释错误，LLM 重解析。 */
export async function createScheduledTask(env: BridgeEnv, p: { displayName: string; cron: string; prompt: string }): Promise<string> {
  const r = await fetch(`${env.url}/task/create`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.nonce}`, "content-type": "application/json" },
    body: JSON.stringify(p),
  });
  return textResult(r, `create_scheduled_task ${p.displayName}`);
}

/** GET /task/list：member 自己的；admin 全量（含 system）。 */
export async function listScheduledTasks(env: BridgeEnv): Promise<string> {
  const r = await fetch(`${env.url}/task/list`, { headers: { authorization: `Bearer ${env.nonce}` } });
  return textResult(r, "list_scheduled_task");
}

/** POST /task/update：改任务 → 新任务卡确认（确认后生效）。 */
export async function updateScheduledTask(env: BridgeEnv, taskId: string, patch: { cron?: string; prompt?: string; displayName?: string }): Promise<string> {
  const r = await fetch(`${env.url}/task/update`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ taskId, ...patch }),
  });
  return textResult(r, `update_scheduled_task ${taskId}`);
}

/** POST /task/delete：删自己的任务（system 拒）。 */
export async function deleteScheduledTask(env: BridgeEnv, taskId: string): Promise<string> {
  const r = await fetch(`${env.url}/task/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
  return textResult(r, `delete_scheduled_task ${taskId}`);
}

/** POST /task/enable：停/启自己的任务（system 拒）。 */
export async function setScheduledTaskEnabled(env: BridgeEnv, taskId: string, enabled: boolean): Promise<string> {
  const r = await fetch(`${env.url}/task/enable`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.nonce}`, "content-type": "application/json" },
    body: JSON.stringify({ taskId, enabled }),
  });
  return textResult(r, `enable_scheduled_task ${taskId}`);
}

/** 通用 tool result（与 pi AgentToolResult 的文本结果结构兼容；不依赖 pi 类型 → 服务端可测）。 */
export interface BridgeToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * chat-bridge 工具统一执行壳：读 bridge 坐标（env）→ 调 fn → 包成 tool result。
 * 无坐标 / fn 抛错 → isError 文本。三工具共用（去重 readBridgeEnv→判空→try/catch→content）。
 * env 作参数（不引用 process 全局，保持与 pi/服务端双端可测，同 readBridgeEnv）。
 */
export async function withBridge(
  label: string,
  env: Record<string, string | undefined>,
  fn: (env: BridgeEnv) => Promise<string>,
): Promise<BridgeToolResult> {
  const bridgeEnv = readBridgeEnv(env);
  if (!bridgeEnv) {
    return { content: [{ type: "text", text: `${label} 失败：AGENTANY_BRIDGE_URL/NONCE 未注入（应由 chat turn 注入）` }], isError: true };
  }
  try {
    return { content: [{ type: "text", text: await fn(bridgeEnv) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `${label} 失败: ${(err as Error).message}` }], isError: true };
  }
}
