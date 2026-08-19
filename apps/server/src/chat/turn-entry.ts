// 「起一轮」入口（ADR-0029）：一模块两薄入口 startUserTurn / startSystemTurn + 私有 deep core。
// 「谁消费输入谁起轮」（ADR-0025 决策 9）：appendMessage(user) + touch + publish(user_message) + enqueue(runTurn)。
// 与旧 inline-turn.ts 的三处复刻（Web/IM/task 各自拼六步）相比，本模块把「busy 预检 / 落库 / 发布 / 入队 /
// 本轮产出」内聚成一个 seam；runTurn 引擎零改动，产出经 whenDone 一等结果返回（不再各消费方猜帧/扫 DB）。
//
// - busy 预检（user flavor）在任何 DB 写入前；skipTurn（程序化卡收口）绕过队列——永不 429。
// - 双保险失败（预检过但入队竞态拒）→ appended_only：消息已落 + error 帧已发（幂等重试不会双消息）。
// - publish 强制注入：调用方选哪个 bus/收集器，入口永不静默丢帧（旧 eventBus? 可选坑归零）。
// - 语义对应 CONTEXT 轮模型「输入双源」：startUserTurn = 用户输入；startSystemTurn = 系统消息（定时任务交付，noBridge）。
import type { RunDeps } from "../runs";
import type { Frame } from "./eventbus";
import type { ConversationQueues } from "./queue";
import { runTurn, type TurnOptions } from "./turn";

/** 本轮产出一等结果（ADR-0029 决策 2）：done 带 assistant 消息 id（消费方按 id 定向读内容）；error 带失败原因；aborted = 无 assistant 产出。 */
export type TurnOutcome =
  | { status: "done"; messageId: number }
  | { status: "error"; error: string }
  | { status: "aborted" };

/** 入口结果三态（决策 3/3b）。whenDone 在 skipTurn（程序化收口无 LLM 轮）时缺省。 */
export type TurnEntryResult =
  | { status: "busy" } // 预检拒：任何 DB 写入前；无 messageId（响应可安全重试）
  | { status: "accepted"; messageId: number; whenDone?: Promise<TurnOutcome> }
  | { status: "appended_only"; messageId: number }; // 双保险失败：消息已落 + error 帧已发

export interface TurnEntryCtx {
  deps: RunDeps;
  queues: ConversationQueues;
  publish: (f: Frame) => void;
}

interface CoreOpts {
  kind: "user" | "system";
  skipTurn?: boolean; // user only：程序化收口不判答
  taskId?: number | string; // system only：user_message 帧携带（前端展示归属）
  turn?: TurnOptions; // user: focusQuestionId；system: extensions/appendSystemPrompt（noBridge 由 kind 强置）
}

/** 用户输入起轮（Web POST /messages 与 IM 回流判答共用——ADR-0025 决策 9「同一条 turn」）。 */
export function startUserTurn(
  ctx: TurnEntryCtx,
  convId: string,
  content: string,
  opts?: { skipTurn?: boolean; focusQuestionId?: number },
): TurnEntryResult {
  return core(ctx, convId, content, {
    kind: "user",
    skipTurn: opts?.skipTurn,
    turn: opts?.focusQuestionId !== undefined ? { focusQuestionId: opts.focusQuestionId } : undefined,
  });
}

/** 系统消息起轮（定时任务交付：产出会话投递 + noBridge——无人值守无交互通道）。 */
export function startSystemTurn(
  ctx: TurnEntryCtx,
  convId: string,
  content: string,
  opts?: { taskId?: number | string; extensions?: string[]; appendSystemPrompt?: string[] },
): TurnEntryResult {
  return core(ctx, convId, content, {
    kind: "system",
    taskId: opts?.taskId,
    turn: { extensions: opts?.extensions, appendSystemPrompt: opts?.appendSystemPrompt, noBridge: true },
  });
}

function core(ctx: TurnEntryCtx, convId: string, content: string, o: CoreOpts): TurnEntryResult {
  const { deps, queues, publish } = ctx;
  // busy 预检（user + 非 skipTurn）：任何 DB 写入前同步判（429 语义；不入队不落库）。
  if (o.kind === "user" && !o.skipTurn && !queues.wouldAcceptHttpTurn(convId)) {
    return { status: "busy" };
  }

  const messageId = deps.chatStore.appendMessage({ conversationId: convId, role: "user", content });
  deps.chatStore.touchConversation(convId); // updatedAt = 列表排序锚（#20）
  publish({
    type: "user_message", id: messageId, content,
    ...(o.skipTurn ? { cardAnswered: true } : {}), // 程序化轮旗标（前端免 LLM 占位）
    ...(o.kind === "system" && o.taskId !== undefined ? { taskId: String(o.taskId) } : {}),
  });
  if (o.skipTurn) return { status: "accepted", messageId }; // 确定性收口轮不判答（无 whenDone）

  // 入队 + interceptor：done/error/aborted 终结帧 → settle whenDone（帧仍全量透传 publish）。
  // runTurn 的 done 帧带 messageId（干净结束）/ 无 messageId（aborted）——见 chat/turn.ts。
  let settled = false;
  let settle!: (out: TurnOutcome) => void;
  const whenDone = new Promise<TurnOutcome>((r) => (settle = r));
  const run = (signal: AbortSignal) =>
    runTurn(deps, convId, content, (f) => {
      if (!settled) {
        if (f.type === "done") {
          settled = true;
          settle(f.messageId !== undefined ? { status: "done", messageId: f.messageId } : { status: "aborted" });
        } else if (f.type === "error") {
          settled = true;
          settle({ status: "error", error: f.message });
        }
      }
      publish(f);
    }, signal, o.turn);

  // 防御：runTurn 收尾（appendMessage/maybeAutoTitle 前置段）若越出其自身 try 抛出，终结帧不到 →
  // whenDone 不能悬挂；catch 兜底 settle + 补 error 帧（runTurn 内部已发过时不会走到这里）。
  const guardedRun = (signal: AbortSignal) =>
    run(signal).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      publish({ type: "error", message: msg });
      if (!settled) {
        settled = true;
        settle({ status: "error", error: msg });
      }
    });

  const ok = o.kind === "user"
    ? queues.enqueueHttpTurn(convId, guardedRun)
    : queues.enqueueEventTurn(convId, guardedRun);
  if (!ok) {
    publish({ type: "error", message: "conversation busy (queue full)" }); // 双保险失败：消息已落 + error 帧已发
    return { status: "appended_only", messageId };
  }
  return { status: "accepted", messageId, whenDone };
}