// 右栏上下文（f2-3 + #31/M4-4）：会话元信息 + 挂起 HITL 摘要 + 「我的任务」。
// 我的任务：member 看自己的（listScheduledTasks 对 member 自动只返自己的——服务端闸），
// 停/手动跑/删同 admin 页语义（复用同套 API）；无 admin 入口（管理页仅 admin 菜单可达）。
import { useCallback, useEffect, useState } from "react";
import { PauseIcon, PlayIcon, TrashIcon } from "@phosphor-icons/react";
import { useChat } from "../store/chat";
import {
  deleteTask,
  listScheduledTasks,
  runTaskNow,
  setTaskEnabled,
  type ScheduledTask,
} from "../api";

const IW = 1.5;

const fmtNext = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** 「我的任务」区（#31）：紧凑列表（名 + cron + 下次），行内停/跑/删。 */
function MyTasks() {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(() => {
    void listScheduledTasks()
      .then(setTasks)
      .catch(() => setTasks([])); // 静默：面板区失败不阻塞对话主区
  }, []);
  useEffect(reload, [reload]);

  return (
    <div data-testid="my-tasks">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">我的任务</h2>
      {tasks === null && <p className="mt-1 text-xs text-muted-foreground">加载中…</p>}
      {tasks !== null && tasks.length === 0 && (
        <p className="mt-1 text-xs text-muted-foreground">暂无定时任务（对话里说「每天早上汇总新闻」即可创建）</p>
      )}
      {tasks !== null && tasks.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {tasks.map((t) => (
            <li key={t.id} className={`rounded-sm bg-secondary px-2 py-1.5 ${t.enabled ? "" : "opacity-60"}`} data-testid="my-task-item">
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={t.prompt}>{t.displayName}</span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    title={running === t.id ? "执行中" : "立即执行一次"}
                    className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                    disabled={running === t.id || !t.enabled}
                    onClick={() => {
                      setRunning(t.id);
                      void runTaskNow(t.id).then((r) => {
                        if (r.status !== 409) setRunning(null);
                      });
                    }}
                  >
                    <PlayIcon size={12} strokeWidth={IW} />
                  </button>
                  <button
                    title={t.enabled ? "停用" : "启用"}
                    className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => void setTaskEnabled(t.id, !t.enabled).then(reload)}
                  >
                    {t.enabled ? <PauseIcon size={12} strokeWidth={IW} /> : <PlayIcon size={12} strokeWidth={IW} />}
                  </button>
                  {confirming === t.id ? (
                    <span className="flex items-center gap-1 text-[11px]">
                      {/* 「删/消」= e2e 契约文本（tasks.spec hasText）——不可改 */}
                      <button className="rounded px-0.5 text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void deleteTask(t.id).then(reload)}>删</button>
                      <button className="rounded px-0.5 text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setConfirming(null)}>消</button>
                    </span>
                  ) : (
                    <button
                      title="删除"
                      className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setConfirming(t.id)}
                    >
                      <TrashIcon size={12} strokeWidth={IW} />
                    </button>
                  )}
                </span>
              </div>
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {t.cron} · 下次 {fmtNext(t.nextFireAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ContextPanel() {
  const conversationId = useChat((s) => s.conversationId);
  const questions = useChat((s) => s.questions);
  const pending = questions.filter((q) => q.status === "pending");

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-background p-4">
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">会话</h2>
        {/* 调试信息不常驻（chat-optimize）：只显尾码，完整 id 收进 title */}
        <p className="mt-1 truncate font-mono text-xs text-foreground" title={conversationId ?? undefined}>
          {conversationId ? `…${conversationId.slice(-8)}` : "-"}
        </p>
      </div>
      <div>
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">待处理</h2>
        {pending.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">无挂起提问</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {pending.map((q) => (
              <li key={q.id} className="rounded-sm bg-secondary px-2 py-1 text-xs text-foreground">
                {q.kind === "approval" ? "审批" : "提问"}：{q.prompt}
              </li>
            ))}
          </ul>
        )}
      </div>
      <MyTasks />
    </aside>
  );
}
