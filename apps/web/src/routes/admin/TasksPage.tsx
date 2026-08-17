// 定时任务管理（#31/M4-4，admin）：全量列表（全部 member 任务 + system seed）。
// 行操作：停/启、手动跑（在跑禁用）、编辑/删除（确认）；行展开：执行历史（状态/触发/起止）+ 未读清零。
// #40/M6-2：新建 system 任务 + system 行编辑/删除弹窗（ADR-0023——蒸馏 seed 冻结态在 TaskDialog 特判）。
// 权限：member 任务与 system 任务的服务端闸在路由层（member 只见自己的、system 硬拒）——
// 本页只在 admin 菜单出现；直接输 URL 的 member 由列表空/NoAccess 兜底。
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  CaretDownIcon,
  CaretRightIcon,
  ClockIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import {
  deleteTask,
  listScheduledTasks,
  listTaskRuns,
  markTaskViewed,
  runTaskNow,
  setTaskEnabled,
  isDistillSeed,
  type ScheduledTask,
  type TaskRun,
} from "../../api";
import { useAuth, ROLE } from "../../store/auth";
import { Button } from "../../components/ui/button";
import { TaskDialog } from "./TaskDialog";

const IW = 1.5;

const fmtTime = (iso: string | null): string => {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "-"
    : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const runStatusText: Record<TaskRun["status"], string> = {
  ok: "成功",
  failed: "失败",
  missed: "错过",
  skipped_overrun: "跳过",
};

/** 手动跑后轮询：新 run 行落库（executeTask 收口即 ok；上限 60s 防 True pi 长跑卡 UI）。
 *  次序约定：listRuns 按 id 升序=最新在尾（与渲染 slice(-8).reverse() 同一约定）。 */
async function waitForNewRun(taskId: string, knownRunId: number | null): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const runs = await listTaskRuns(taskId);
      const latest = runs[runs.length - 1];
      if (latest && latest.id !== knownRunId && latest.finishedAt != null) return;
    } catch {
      /* 瞬时错继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** 行状态：system/已停用 区分语义色（system 不是错误态——只读种子）。 */
const scopeBadge = (t: ScheduledTask): string =>
  t.scope === "system"
    ? "bg-primary/15 text-primary"
    : t.enabled
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : "bg-muted text-muted-foreground";

export function AdminTasksPage() {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // #40：弹窗态——null=关；"new"=新建；行对象=编辑该任务
  const [dialogTask, setDialogTask] = useState<ScheduledTask | "new" | null>(null);
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const isAdmin = status === "anonymous" || user?.role === ROLE.admin;

  const reload = useCallback(() => {
    void listScheduledTasks()
      .then(setTasks)
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);
  useEffect(reload, [reload]);

  // 展开即清未读（票面：点开任务详情即清）+ 拉执行历史
  const openHistory = (t: ScheduledTask) => {
    setExpanded((cur) => (cur === t.id ? null : t.id));
    if (t.unreadRuns && t.unreadRuns > 0) {
      void markTaskViewed(t.id).then(reload);
    }
  };

  if (!isAdmin) return <NoAccess />;

  return (
    <div className="main flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <h1 className="text-base font-semibold">定时任务</h1>
        {/* #40：admin 新建 system 任务（全域+权限开关在弹窗内定） */}
        <Button className="h-7 px-2 text-xs" onClick={() => setDialogTask("new")} data-testid="task-create-btn">
          <PlusIcon size={12} strokeWidth={IW} />
          新建
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        {err && <p className="mx-auto mb-4 max-w-4xl text-sm text-destructive">{err}</p>}
        {tasks === null && <p className="text-sm text-muted-foreground">加载中…</p>}
        {tasks !== null && (
          <div className="mx-auto max-w-4xl overflow-hidden rounded-md border border-border" data-testid="tasks-table">
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                expanded={expanded === t.id}
                onToggle={() => openHistory(t)}
                onChanged={reload}
                onEdit={() => setDialogTask(t)}
              />
            ))}
            {tasks.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">暂无任务</p>
            )}
          </div>
        )}
      </div>
      {dialogTask !== null && (
        <TaskDialog
          task={dialogTask === "new" ? null : dialogTask}
          onClose={() => setDialogTask(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

function TaskRow({
  task,
  expanded,
  onToggle,
  onChanged,
  onEdit,
}: {
  task: ScheduledTask;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onEdit: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const isSystem = task.scope === "system";
  const isDistill = isDistillSeed(task); // 冻结特判单出口（review S1）

  // 展开即拉历史（手动跑后 task.unreadRuns 变化 → 重拉：展开态能看到新 run 行）
  useEffect(() => {
    if (!expanded) return;
    setRuns(null);
    void listTaskRuns(task.id).then(setRuns).catch(() => setRuns([]));
  }, [expanded, task.id, task.unreadRuns]);

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await runTaskNow(task.id);
      if (r.status === 409) return; // 在跑 → 按钮保持禁用
      if (r.ok) {
        // 等执行收口（stub 秒级、真 pi 分钟级——轮询 run 行直到有新行），收口即刷历史与列表
        await waitForNewRun(task.id, runs != null && runs.length > 0 ? runs[runs.length - 1].id : null);
        setRuns(null); // 触发展开态 effect 重拉
      }
      setRunning(false);
      onChanged(); // 列表行 unreadRuns/badge 同步
    } catch {
      setRunning(false);
    }
  };

  return (
    <div className={`border-b border-border/50 last:border-0 ${task.enabled ? "" : "opacity-60"}`}>
      <div className="flex items-center gap-2 px-3 py-2 hover:bg-accent/40">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle} data-testid="task-row">
          {expanded ? <CaretDownIcon size={12} strokeWidth={IW} /> : <CaretRightIcon size={12} strokeWidth={IW} />}
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{task.displayName}</span>
          <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] ${scopeBadge(task)}`}>
            {isSystem ? "system" : task.enabled ? "启用" : "停用"}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{task.cron}</span>
          {task.unreadRuns ? (
            <span
              className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground"
              data-testid="unread-badge"
            >
              {task.unreadRuns}
            </span>
          ) : null}
        </button>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={running || !task.enabled}
            onClick={() => void runNow()}
            title={running ? "执行中" : "立即执行一次"}
            data-testid="run-now"
          >
            <PlayIcon size={12} strokeWidth={IW} />
            跑
          </Button>
          {isSystem ? (
            // #40/ADR-0023 决策 4：admin 经 UI 全管理——编辑（蒸馏 seed=冻结形态）+ 启停 + 删除
            // （蒸馏 seed 不可删——服务端 403 兜底，UI 不出删除钮）
            <>
              <Button
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={onEdit}
                title={isDistill ? "编辑（仅触发频率）" : "编辑任务"}
                data-testid="task-edit-btn"
              >
                <PencilSimpleIcon size={12} strokeWidth={IW} />
              </Button>
              <Button
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => void setTaskEnabled(task.id, !task.enabled).then(onChanged)}
              >
                {task.enabled ? <PauseIcon size={12} strokeWidth={IW} /> : <PlayIcon size={12} strokeWidth={IW} />}
                {task.enabled ? "停" : "启"}
              </Button>
              {!isDistill && (
                confirming ? (
                  <span className="flex items-center gap-1">
                    <button className="text-[11px] text-destructive hover:underline" onClick={() => void deleteTask(task.id).then(onChanged)} data-testid="confirm-delete">
                      确认删除
                    </button>
                    <button className="text-[11px] text-muted-foreground hover:underline" onClick={() => setConfirming(false)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <Button variant="outline" className="h-7 px-2 text-xs" onClick={() => setConfirming(true)} data-testid="delete-task">
                    <TrashIcon size={12} strokeWidth={IW} />
                  </Button>
                )
              )}
            </>
          ) : confirming ? (
            <span className="flex items-center gap-1">
              <button className="text-[11px] text-destructive hover:underline" onClick={() => void deleteTask(task.id).then(onChanged)} data-testid="confirm-delete">
                确认删除
              </button>
              <button className="text-[11px] text-muted-foreground hover:underline" onClick={() => setConfirming(false)}>
                取消
              </button>
            </span>
          ) : (
            <>
              <Button
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => void setTaskEnabled(task.id, !task.enabled).then(onChanged)}
                data-testid="toggle-enabled"
              >
                {task.enabled ? "停用" : "启用"}
              </Button>
              <Button variant="outline" className="h-7 px-2 text-xs" onClick={() => setConfirming(true)} data-testid="delete-task">
                <TrashIcon size={12} strokeWidth={IW} />
              </Button>
            </>
          )}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-border/40 bg-secondary/20 px-3 py-2 pl-8">
          <p className="mt-0.5 break-all text-xs text-muted-foreground" title={task.prompt}>{task.prompt}</p>
          <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <ClockIcon size={11} strokeWidth={IW} />
            下次：{fmtTime(task.nextFireAt)}
          </p>
          <div className="mt-2">
            {runs === null ? (
              <p className="text-xs text-muted-foreground">加载历史…</p>
            ) : runs.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无执行记录</p>
            ) : (
              <ul className="flex flex-col" data-testid="task-runs">
                {runs.slice(-8).reverse().map((r) => (
                  <li key={r.id} className="border-b border-border/30 py-1 last:border-0 font-mono text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-2">
                      <span
                        className={
                          r.status === "ok"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : r.status === "failed"
                              ? "text-destructive"
                              : "text-muted-foreground"
                        }
                      >
                        {runStatusText[r.status]}
                      </span>
                      <span>{r.trigger === "manual" ? "手动" : "定时"}</span>
                      <span>{fmtTime(r.startedAt ?? r.finishedAt)}</span>
                    </span>
                    {/* #32 headless 日志：失败详情（管理页执行历史可读——system 任务产出即此） */}
                    {r.note && <span className="block truncate text-destructive/90" title={r.note}>{r.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NoAccess() {
  const navigate = useNavigate();
  return (
    <div className="main flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3">
      <p className="text-sm text-muted-foreground">无权限：管理页仅管理员可用。</p>
      <Button onClick={() => navigate("/")}>返回对话</Button>
    </div>
  );
}
