// 单个对话 turn 的编排（ADR-0009 BE-Q3/Q5）：拿到 signal 后 → runPiStream 边吐 delta →
// 攒全文 → 干净结束写一行助手消息 + 发 done；aborted 发 done.aborted（不写消息）；抛错发 error。
import { makeRunPiStream } from "../pi/runPi-factory";
import { issueNonce, revokeNonce } from "../bridge/nonce";
import { BRIDGE_PORT } from "../bridge/server";
import { CHAT_EXTENSIONS } from "./extensions";
import { scopeOf, resolveScopePaths } from "../scope";
import { listWorkflows } from "../registry";
import { loadProjectDoc } from "./project-doc";
import { composeSystemPrompt } from "./compose-prompt";
import { collectExperience } from "../knowledge/repo";
import type { RunDeps } from "../runs";
import type { Frame } from "./eventbus";

export type TurnFrame = Frame; // 判别式联合（eventbus.Frame）
export type TurnSend = (frame: Frame) => void;

// chat turn 的基础 system 追加（--append-system-prompt）：角色 + 工具清单 + 判答指引。
// 动态段（项目背景/工作流目录/挂起 run/pending ask）由 composeSystemPrompt（#16/#17）产，在下prepend 本常量。
const CHAT_SYSTEM_PROMPT = `你是 agentany 的对话助手，用户是非技术内部成员，请用自然、清晰的语言回应。
你可用以下工具（经桥接通道）：
- ping：探活服务端
- start_workflow：后台异步启动一个工作流（run 不阻塞对话），进度会自动推给用户
- read_run：读取某 run 的状态 / 步骤 / 最新输出
- ask_user：工作流挂起需用户决策时，创建结构化提问卡片（prompt + 选项按钮）。立即返回、不阻塞；用户下一轮回答后系统自动续跑
- resume_workflow：用归一化的用户答案续跑挂起的工作流。调用**立即返回** {status:running}——续跑在后台异步进行，进度会经持久流自动推送，不需要你等待轮询
- create_scheduled_task：用户想要周期性任务（如「每 4 小时汇总新闻」）时，解析出任务名+cron+任务目标并调用——服务端出任务卡让用户确认即建。频率下限 1 小时，过密返回错误需重新解析
- list_scheduled_task / update_scheduled_task / delete_scheduled_task / enable_scheduled_task：查看/修改/删除/停启用用户的定时任务（修改会出新任务卡确认；系统任务只读不可动）
当收到以「[系统事件]」开头的消息时，那是工作流状态变化（完成 / 挂起 / 失败），请据此向用户说明。
当收到以「[待处理提问]」开头的注入时，判断用户本次消息是否回答了该提问：是→将答案归一化为符合续跑契约的对象，调 resume_workflow(runId, resumeData)；否→正常回应用户。`;

/** runTurn 可覆盖项（#29 定时任务）：extension 集（任务 pi 无 bridge）与 system 追加（无人值守语境）。 */
export interface TurnOptions {
  extensions?: string[];
  appendSystemPrompt?: string[];
  /** true=不发 bridge nonce、沙箱不放行 loopback（review-c4：任务 pi 无交互通道——nonce 落地即被 bash curl 可用）。 */
  noBridge?: boolean;
}

export async function runTurn(
  deps: RunDeps,
  conversationId: string,
  userContent: string,
  send: TurnSend,
  signal: AbortSignal,
  opts?: TurnOptions,
): Promise<void> {
  const conv = deps.store.getConversation(conversationId);
  if (!conv) { send({ type: "error", message: "conversation not found" }); return; }
  if (process.env.AGENTANY_DEBUG_BLOCKS) console.error(`[dbg-turn] runTurn ${conversationId}: "${userContent.slice(0, 40)}"`);

  const makeStream = deps.runPiStreamFactory ?? makeRunPiStream;
  const runPiStream = makeStream({ workspaceId: conv.workspaceId, sessionId: `chat-${conv.id}`, extensions: opts?.extensions ?? CHAT_EXTENSIONS });

  const nonce = issueNonce(conv.id); // per-turn bridge 令牌（#11）；finally 吊销
  // 每轮注入（#15 角色 + #17 项目背景/工作流目录/挂起 run + #16 pending ask 判答）。
  // #18：只注入 kind='ask' 的提问——审批卡走 /approvals（人类点），不进 pi 判答。
  const cwd = resolveScopePaths(scopeOf(conv.workspaceId), conv.workspaceId).cwd;
  const appendDynamic = composeSystemPrompt({
    projectDoc: loadProjectDoc(cwd),
    workflows: listWorkflows(),
    suspendedRuns: deps.store.listSuspendedRuns(conversationId),
    pendingAsks: deps.store.listQuestions(conversationId, { includeAnswered: false, kind: "ask" }).map((q) => ({
      runId: q.runId ?? "", prompt: q.prompt, options: (q.options as string[]) ?? [], resumeSchema: q.resumeSchema,
    })),
    // #35：三层经验之 global+member 注入 chat turn（member 按会话归属成员；任务 turn 在 execute.ts 只注 global）
    experience: collectExperience(conv.userId),
  });
  let result;
  try {
    result = await runPiStream({
      prompt: userContent, // pi session chat-<conversationId> 持历史，每轮只送新消息（事件 turn 时 = 事件 prompt）
      signal,
      // f3/ADR-0019：block 三帧是唯一增量通道（legacy delta 已删）；done 不带全文（text 字段已删）
      onBlock: (b) => {
        if (b.op === "start") send({ type: "block_start", blockId: b.blockId, kind: b.kind, meta: b.meta });
        else if (b.op === "delta") send({ type: "block_delta", blockId: b.blockId, delta: b.delta });
        else send({ type: "block_end", blockId: b.blockId });
      },
      bridge: opts?.noBridge === true
        ? undefined // review-c4：任务 turn 无交互通道——nonce 不注入 env、loopback 不放行（bash curl 亦不可达）
        : { port: BRIDGE_PORT, nonce, url: `http://localhost:${BRIDGE_PORT}` },
      appendSystemPrompt: opts?.appendSystemPrompt ?? [CHAT_SYSTEM_PROMPT, ...appendDynamic],
    });
  } catch (e) {
    // 真 pi：abort → 子进程被杀 → reject。stub：可能 resolve（下面 signal.aborted 兜底）。
    if (process.env.AGENTANY_DEBUG_BLOCKS) console.error(`[dbg-turn] FAILED ${conversationId}:`, e);
    if (signal.aborted) { send({ type: "done", aborted: true }); return; }
    send({ type: "error", message: (e as Error)?.message ?? String(e) });
    return;
  } finally {
    revokeNonce(nonce); // 正常/abort/出错都吊销（内存 Map、重启无残留）
  }

  if (signal.aborted) { send({ type: "done", aborted: true }); return; } // stub resolve 但已 abort
  // 冗余落库（#20：messages 表保留供差异比对；pi session 才是历史真相源）
  const msgId = deps.store.appendMessage({ conversationId: conv.id, role: "assistant", content: result.text });
  send({ type: "done", messageId: msgId });
  maybeAutoTitle(deps, conversationId, makeStream, send); // #命名：fire-and-forget（不阻塞 done 后续）
}

// ── #命名：首轮对话后 LLM 提取主题作会话名 ──
// fire-and-forget：done 已发，命名晚到/失败都不影响主流程；落库只改 title（排序锚 updatedAt 不动）。

// #命名-长度约束：标题 8~24 字（用户定）——太短重名（「新会话」撞名事故），太长失去摘要感。
const TITLE_MIN = 8;
const TITLE_MAX = 24;
const TITLE_INSTRUCTION = "提取主题"; // 命名调用的 prompt 特征（测试识别用；指令正文见 TITLE_PROMPT）
const TITLE_PROMPT = `从下面这段用户提问中${TITLE_INSTRUCTION}，输出一个会话标题：长度至少 ${TITLE_MIN} 个字、最多 ${TITLE_MAX} 个字。
只输出标题本身，不要任何前缀、引号或解释。`;

/** turn 完成后按需命名：title=null 且素材够（累计 user 消息 ≥TITLE_MIN 字）才触发。
 * 素材不足/LLM 失败/输出违规 → 一律跳过（title 保持 null 显示「新会话」），下一轮 turn 自然重试——
 * 信息不足就不硬造名字（用户定：等第二次对话再提取，以此类推）。幂等：rename 后不再进。 */
async function maybeAutoTitle(
  deps: RunDeps,
  conversationId: string,
  makeStream: typeof makeRunPiStream,
  send: TurnSend,
): Promise<void> {
  const conv = deps.store.getConversation(conversationId);
  if (!conv || conv.title != null) return;
  // 素材 = 累计全部 user 消息（DB messages 表每轮落库，可靠累计源）——首轮太短时第二轮补足即触发。
  const material = deps.store
    .listMessages(conversationId)
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  if (material.trim().length < TITLE_MIN) return; // 素材不足 → 本轮跳过，title 保持 null
  let title: string;
  try {
    // 一次性命名调用：独立 session（headless，不污染会话本身的 pi session 历史），无工具无 bridge。
    const oneShot = makeStream({ workspaceId: conv.workspaceId, sessionId: `title-${conversationId}` });
    const r = await oneShot({ prompt: `${TITLE_PROMPT}\n\n用户提问：${material.slice(0, 500)}`, timeoutMs: 30_000 });
    const got = r.text.trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, TITLE_MAX);
    if (got.length < TITLE_MIN) return; // 输出违规（太短）→ 跳过不硬造，下轮再试
    title = got;
  } catch {
    return; // LLM 失败 → 跳过（不命名），下轮重试
  }
  if (deps.store.getConversation(conversationId)?.title != null) return; // 并发竞态：他者已命名则弃
  deps.store.renameConversation(conversationId, title);
  send({ type: "title", title }); // 走 turn 的 send——与 done 同一 EventBus（deps.eventBus 可能未注入）
}
