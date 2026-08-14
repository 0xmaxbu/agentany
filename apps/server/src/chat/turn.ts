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
import type { RunDeps } from "../runs";
import type { Frame } from "./eventbus";

export type TurnFrame = Frame; // 判别式联合（eventbus.Frame）；alias 保 turn-trigger import
export type TurnSend = (frame: Frame) => void;

// chat turn 的基础 system 追加（--append-system-prompt）：角色 + 工具清单 + 判答指引。
// 动态段（项目背景/工作流目录/挂起 run/pending ask）由 composeSystemPrompt（#16/#17）产，在下prepend 本常量。
const CHAT_SYSTEM_PROMPT = `你是 agentany 的对话助手，用户是非技术内部成员，请用自然、清晰的语言回应。
你可用以下工具（经桥接通道）：
- ping：探活服务端
- start_workflow：后台异步启动一个工作流（run 不阻塞对话），进度会自动推给用户
- read_run：读取某 run 的状态 / 步骤 / 最新输出
- ask_user：工作流挂起需用户决策时，创建结构化提问卡片（prompt + 选项按钮）。立即返回、不阻塞；用户下一轮回答后系统自动续跑
- resume_workflow：用归一化的用户答案续跑挂起的工作流
当收到以「[系统事件]」开头的消息时，那是工作流状态变化（完成 / 挂起 / 失败），请据此向用户说明。
当收到以「[待处理提问]」开头的注入时，判断用户本次消息是否回答了该提问：是→将答案归一化为符合续跑契约的对象，调 resume_workflow(runId, resumeData)；否→正常回应用户。`;

export async function runTurn(
  deps: RunDeps,
  conversationId: string,
  userContent: string,
  send: TurnSend,
  signal: AbortSignal,
): Promise<void> {
  const conv = deps.store.getConversation(conversationId);
  if (!conv) { send({ type: "error", message: "conversation not found" }); return; }

  const makeStream = deps.runPiStreamFactory ?? makeRunPiStream;
  const runPiStream = makeStream({ workspaceId: conv.workspaceId, sessionId: `chat-${conv.id}`, extensions: CHAT_EXTENSIONS });

  const nonce = issueNonce(conv.id); // per-turn bridge 令牌（#11）；finally 吊销
  let full = "";
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
  });
  try {
    await runPiStream({
      prompt: userContent, // pi session chat-<conversationId> 持历史，每轮只送新消息（事件 turn 时 = 事件 prompt）
      signal,
      onDelta: (t) => { full += t; send({ type: "delta", text: t }); },
      // #20：block 三帧（thinking/tool_use/tool_result）——与 legacy delta 双发，f3 前端切换后删 legacy
      onBlock: (b) => {
        if (b.op === "start") send({ type: "block_start", blockId: b.blockId, kind: b.kind, meta: b.meta });
        else if (b.op === "delta") send({ type: "block_delta", blockId: b.blockId, delta: b.delta });
        else send({ type: "block_end", blockId: b.blockId });
      },
      bridge: { port: BRIDGE_PORT, nonce, url: `http://localhost:${BRIDGE_PORT}` },
      appendSystemPrompt: [CHAT_SYSTEM_PROMPT, ...appendDynamic],
    });
  } catch (e) {
    // 真 pi：abort → 子进程被杀 → reject。stub：可能 resolve（下面 signal.aborted 兜底）。
    if (signal.aborted) { send({ type: "done", aborted: true }); return; }
    send({ type: "error", message: (e as Error)?.message ?? String(e) });
    return;
  } finally {
    revokeNonce(nonce); // 正常/abort/出错都吊销（内存 Map、重启无残留）
  }

  if (signal.aborted) { send({ type: "done", aborted: true }); return; } // stub resolve 但已 abort
  const msgId = deps.store.appendMessage({ conversationId: conv.id, role: "assistant", content: full });
  send({ type: "done", messageId: msgId, text: full });
}
