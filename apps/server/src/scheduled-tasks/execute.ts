// executeTask 真实现（#29/M4-3a）：到点/手动执行定时任务。
// 同构 chat turn：任务 prompt 作为 user 消息投进任务的产出会话 → enqueueEventTurn
// （run_* 自动 turn 同款队列语义：同会话串行、不占 HTTP 429 配额）→ runTurn 复用
// （system 注入/block 三帧/SSE/turn 管理全免费）。
// 差异点（ADR-0021 修订版）：任务 pi **无 bridge**——TASK_EXTENSIONS 仅 tavily（无人值守
// 不能 start_workflow/ask_user，loopback 无端口）；错误转为产出会话内的可读说明。
// system 任务（#32/M4-5）走 headless：无产出会话，pi 一次性跑（makeRunPi 路径，
// 同 taskId 固定 session 跨执行连续），产出=task_runs 日志（note 记失败详情，管理页可读）。
import { repoExtensionPath, generalWorkspacePath, workspaceWorkspacePath, taskSessionDir, repoSkillPaths, forAllWorkspaces } from "../config";
import { runPi } from "../pi/runPi";
import { startSystemTurn } from "../chat/turn-entry";
import type { ConversationQueues } from "../chat/queue";
import type { EventBus, Frame } from "../chat/eventbus";
import { resolveScopePaths, scopeOf } from "../scope";
import { collectExperience } from "../knowledge/repo";
import { runDistill } from "../knowledge/distill";
import type { RunDeps } from "../runs";
import type { ScheduledTaskRow, TaskRunTrigger } from "./store";
import { WRITE_TOOLS, wsRelativePath } from "./files";
import type { WorkspaceStore } from "../workspaces/store";

// 蒸馏 seed 任务 id（迁移 0013 种的 system 任务——executeTask 以此特判走蒸馏链）。
export const DISTILL_TASK_ID = "t_seed_distill";

// 任务 pi 的 extension 集：仅基础网络（tavily）——无 chat-bridge（chat/extensions.ts 对照）。
export const TASK_EXTENSIONS: string[] = [
  repoExtensionPath("tavily-search/extensions/web-search.ts"),
];

/**
 * #39/ADR-0023 决策 1：全域=全部 ws 的 workspace 目录（公司 ws→general 路径 + 其余→
 * data/workspaces/<id>/workspace），执行时动态解析（新建 ws 自动纳入）。
 * DB/knowledge/pi-sessions 三域不在列（deny 侧默认拒——不进白名单即不可见）。
 * C1/#66：ws 目录枚举起用 config.forAllWorkspaces 单点（与蒸馏语料同循环同源，防漂移）。
 */
export function fullDomainWorkspaceDirs(workspaceStore?: WorkspaceStore): string[] {
  return forAllWorkspaces(workspaceStore?.listAllWorkspaces() ?? [], generalWorkspacePath(), workspaceWorkspacePath);
}

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
    // ── #32 headless 分支：system 任务（蒸馏 seed）无产出会话 ──
    // pi 一次性跑（缓冲版 runPi）：cwd=公司 ws（scopeOf null→显式 general），session 按 taskId 固定
    // （蒸馏跨执行积累上下文）。产出=task_runs 日志：note 记失败详情，无 outputMessageId。
    if (task.scope === "system") {
      const runId = own ? deps.taskStore!.recordRun({ taskId: task.id, trigger, status: "ok", startedAt: new Date().toISOString() }) : runIdProvided!;
      try {
        if (task.id === DISTILL_TASK_ID) {
          // #36 蒸馏特判：不走通用 pi 通道（蒸馏需 zero-extension 纯文本调用 + 服务端 git 收口，
          // runDistill 全链自足）；note 带 commit hash/失败原因（admin 任务页可读）。
          const r = await runDistill(deps, deps.runPiFactory);
          deps.taskStore!.finishRun(runId, { status: r.ok ? "ok" : "failed", note: r.note });
        } else {
          // #39/ADR-0023：通用 system 任务=全域白名单 + 任务级权限开关。
          // 全域=全部 ws workspace 目录（动态解析）；allowWrite=false → 全 ro、rw 仅任务 sessionDir
          // （沙箱全盘禁写下唯一可写——/tmp 也不可写）；allowSearch=false → 不加载搜索扩展（工具层）。
          // sessionDir=data/tasks/<id>/pi-sessions（任务专属——不与 chat 会话共用区混放，历史域排除）。
          const wsDirs = fullDomainWorkspaceDirs(deps.workspaceStore);
          const sessionDir = taskSessionDir(task.id);
          const extensions = task.allowSearch ? TASK_EXTENSIONS : [];
          // C1/#66：system headless 的 runPi 直调经 deps.runPiFn 可注入（缺省真 runPi；测试喂假免 spyOn 模块 mock）
          await (deps.runPiFn ?? runPi)({
            prompt: task.prompt,
            sessionId: `task-${task.id}`,
            sessionDir,
            cwd: generalWorkspacePath(), // pi 启动目录锚公司 ws（跨 ws 经绝对路径触达）
            extensions,
            sandboxAllow: {
              rw: task.allowWrite ? [...wsDirs, sessionDir] : [sessionDir],
              ro: task.allowWrite ? [...repoSkillPaths()] : [...wsDirs, ...repoSkillPaths()],
            },
          });
          deps.taskStore!.finishRun(runId, { status: "ok" });
        }
      } catch (e) {
        const note = (e as Error)?.message ?? String(e);
        deps.taskStore!.finishRun(runId, { status: "failed", note });
      }
      return;
    }
    // workspace 任务无产出会话（悬空/异常数据）：failed 收口（不进 headless——那是 system 专属语义）
    if (!task.outputConversationId) {
      const rid = own ? deps.taskStore!.recordRun({ taskId: task.id, trigger, status: "failed" }) : runIdProvided!;
      if (!own) deps.taskStore!.finishRun(rid, { status: "failed" });
      console.error(`[task] workspace task without output conversation: ${task.id}`);
      return;
    }
    const convId = task.outputConversationId;
    // 悬空引用（会话已被 admin 硬删）：直接 failed，不写孤儿消息
    if (!deps.chatStore.getConversation(convId)) {
      const rid = own ? deps.taskStore!.recordRun({ taskId: task.id, trigger, status: "failed" }) : runIdProvided!;
      if (!own) deps.taskStore!.finishRun(rid, { status: "failed" });
      return;
    }
    const send: (f: Frame) => void = (frame: Frame) => eventBus.publish(convId, frame);
    const runId = own ? deps.taskStore!.recordRun({ taskId: task.id, trigger, status: "ok", startedAt: new Date().toISOString() }) : runIdProvided!;

    // #30 产出文件收集：钩 block_start(tool_use) 的 write/edit 路径 → run 收口时登记 task_files。
    const convRow = deps.chatStore.getConversation(convId)!;
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

    // ADR-0029：startSystemTurn 内聚落库/发布/入队；产出经 whenDone 一等结果（删 send 闭包收集 + drained）。
    // 帧 带 taskId 标志（入口携带）：纯展示。文件收集挂 publish 钩子（与 SSE publish 同流）。
    // runTurn 引擎零改动——entry 对 send 钩子加 interceptor 收 done/error → whenDone。
    const res = startSystemTurn(
      { deps, queues, publish: (f) => { collectFile(f); send(f); } },
      convId, task.prompt,
      {
        taskId: task.id,
        extensions: TASK_EXTENSIONS,
        // #35/D1：任务 turn 吃 global 经验（产出质量受益）、不吃 member 级（任务语境=公司/共享 ws，非个人对话）
        appendSystemPrompt: [TASK_SYSTEM_PROMPT, ...collectExperience()],
      },
    );
    let outputMessageId: string | null = null;
    let failure: string | null = null;
    if (res.status === "appended_only") failure = "conversation busy (event queue full)"; // 双保险失败（消息已落 + error 帧已发）
    else if (res.status === "accepted") {
      const outcome = await res.whenDone!; // 等本 turn 真跑完再收口——finishRun 太早会丢 outputMessageId/错误
      if (outcome.status === "error") failure = outcome.error;
      else if (outcome.status === "done") outputMessageId = String(outcome.messageId);
    }

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
      const errId = deps.chatStore.appendMessage({ conversationId: convId, role: "assistant", content: errMsg });
      outputMessageId = String(errId);
    }
    deps.taskStore!.finishRun(runId, { status: failure ? "failed" : "ok", outputMessageId });
  };
}
