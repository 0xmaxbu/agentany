// executeTask 真实现（#29/M4-3a）：到点/手动执行定时任务。
// 同构 chat turn：任务 prompt 作为 user 消息投进任务的产出会话 → enqueueEventTurn
// （run_* 自动 turn 同款队列语义：同会话串行、不占 HTTP 429 配额）→ runTurn 复用
// （system 注入/block 三帧/SSE/turn 管理全免费）。
// 差异点（ADR-0021 修订版）：任务 pi **无 bridge**——TASK_EXTENSIONS 仅 tavily（无人值守
// 不能 start_workflow/ask_user，loopback 无端口）；错误转为产出会话内的可读说明。
// system 任务 headless 分支（无产出会话）属 #32——本文件对 scope=system 直接 failed。
import { repoExtensionPath } from "../config";import { runTurn, type TurnSend } from "../chat/turn";
import type { ConversationQueues } from "../chat/queue";
import type { EventBus, Frame } from "../chat/eventbus";
import { resolveScopePaths, scopeOf } from "../scope";
import type { RunDeps } from "../runs";
import type { ScheduledTaskRow, TaskRunTrigger } from "./store";
import { WRITE_TOOLS, wsRelativePath } from "./files";

// 任务 pi 的 extension 集：仅基础网络（tavily）——无 chat-bridge（chat/extensions.ts 对照）。
export const TASK_EXTENSIONS: string[] = [
  repoExtensionPath("tavily-search/extensions/web-search.ts"),
];

// 任务 turn 的 system 追加：无人值守语境（无桥接工具、无交互语义）。
const TASK_SYSTEM_PROMPT = `你是 agentany 的定时任务执行器，正在无人值守地执行一个周期任务。
你没有交互工具（不能向用户提问、不能启动工作流）——请独立完成任务目标。
如果任务目标需要你无法获得的信息或无法完成的动作，直接在产出文本中说明缺了什么，不要尝试交互。`;

export interface ExecuteTaskDeps {
  deps: RunDeps;
  queues: ConversationQueues; // 产出会话的 turn FIFO（与 chat 共队列语义：同会话串行）
  eventBus: EventBus; // SSE 帧（产出会话的持久流；前端开着就能看到任务跑的实时块）
}

export type ExecuteTask = (task: ScheduledTaskRow, trigger: TaskRunTrigger) => Promise<void>;

/**
 * 造 executeTask（index.ts 装配 + 测试直构同款）。
 * run 行生命周期自足：调用方（scheduler）传 runId 则收口它（tick 先 recordRun 的行）；
 * 不传则自己 recordRun（测试/裸调同语义——外部行为一致：跑完 task_runs 必有一行收口）。
 */
export function makeExecuteTask(ctx: ExecuteTaskDeps): (task: ScheduledTaskRow, trigger: TaskRunTrigger, runId?: number) => Promise<void> {
  const { deps, queues, eventBus } = ctx;
  return async (task, trigger, runIdProvided) => {
    const own = runIdProvided === undefined;
    // system 任务（蒸馏 seed）无产出会话——headless 执行链属 #32；现阶段直接收 failed。
    if (task.scope === "system" || !task.outputConversationId) {
      const rid = own ? deps.taskStore!.recordRun({ taskId: task.id, trigger, status: "failed" }) : runIdProvided!;
      if (!own) deps.taskStore!.finishRun(rid, { status: "failed" });
      console.error(`[task] no output conversation (scope=${task.scope}) — headless chain is #32: ${task.id}`);
      return;
    }
    const convId = task.outputConversationId;
    // 悬空引用（会话已被 admin 硬删）：直接 failed，不写孤儿消息
    if (!deps.store.getConversation(convId)) {
      const rid = own ? deps.taskStore!.recordRun({ taskId: task.id, trigger, status: "failed" }) : runIdProvided!;
      if (!own) deps.taskStore!.finishRun(rid, { status: "failed" });
      return;
    }
    const send: TurnSend = (frame: Frame) => eventBus.publish(convId, frame);
    const runId = own ? deps.taskStore!.recordRun({ taskId: task.id, trigger, status: "ok", startedAt: new Date().toISOString() }) : runIdProvided!;

    // #30 产出文件收集：钩 block_start(tool_use) 的 write/edit 路径 → run 收口时登记 task_files。
    const convRow = deps.store.getConversation(convId)!;
    const wsCwd = resolveScopePaths(scopeOf(convRow.workspaceId), convRow.workspaceId).cwd;
    const written = new Set<string>();
    const collectFile = (f: Frame): void => {
      if (f.type !== "block_start" || f.kind !== "tool_use" || !f.meta) return;
      const name = String(f.meta.name ?? "");
      if (!WRITE_TOOLS.has(name)) return;
      const raw = (f.meta.arguments as Record<string, unknown> | undefined)?.path;
      if (typeof raw !== "string") return;
      const rel = wsRelativePath(wsCwd, raw);
      if (rel !== undefined) written.add(rel); // 归一后去重（write+edit 同文件只一行）
    };

    // 任务 prompt 先落 user 消息（历史可读：产出会话里每次执行的目标原文）+ 推流
    const userMsgId = deps.store.appendMessage({ conversationId: convId, role: "user", content: task.prompt });
    deps.store.touchConversation(convId);
    eventBus.publish(convId, { type: "user_message", id: userMsgId, content: task.prompt });

    let outputMessageId: string | null = null;
    let failure: string | null = null;
    const ok = queues.enqueueEventTurn(convId, async (signal) => {
      // runTurn 自己写 assistant 消息并发 done（messageId）——钩帧取 outputMessageId。
      await runTurn(deps, convId, task.prompt, (f) => {
        collectFile(f);
        if (f.type === "done" && f.messageId !== undefined) outputMessageId = String(f.messageId);
        if (f.type === "error") failure = f.message;
        send(f);
      }, signal, { extensions: TASK_EXTENSIONS, appendSystemPrompt: [TASK_SYSTEM_PROMPT] });
    });
    if (!ok) failure = "conversation busy (event queue full)";
    if (ok) await queues.drained(convId); // 等本 turn 真跑完（FIFO 快照）再收口——finishRun 太早会丢 outputMessageId/错误

    // #30：登记产出文件（run 已收口前；taskRunId 是 text 列）。失败不阻塞 run 收口（文件列表少行可接受）。
    for (const rel of written) {
      try {
        deps.taskStore!.addTaskFile({ taskRunId: String(runId), path: rel, name: rel.split("/").pop() ?? rel });
      } catch (e) {
        console.warn(`[task] addTaskFile failed (${task.id}/${rel}):`, e);
      }
    }

    if (failure) {
      // 可读错误说明落会话（runTurn 出错只发 error 帧不写消息——历史里会凭空消失，补一条系统说明）
      const errMsg = `定时任务「${task.displayName}」执行失败：${failure}`;
      const errId = deps.store.appendMessage({ conversationId: convId, role: "assistant", content: errMsg });
      outputMessageId = String(errId);
    }
    deps.taskStore!.finishRun(runId, { status: failure ? "failed" : "ok", outputMessageId });
  };
}
