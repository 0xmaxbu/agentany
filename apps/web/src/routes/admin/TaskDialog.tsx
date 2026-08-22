// #40/M6-2 system 任务新建/编辑弹窗（ADR-0023）：
// - 范围区=固定「System（全域）」徽标——System Workspace 是逻辑概念，无范围选择器。
// - 权限双开关：allowWrite（缺省开；关=全盘禁写、产出仅执行日志——明示严格语义）、
//   allowSearch（缺省关；工具层：不加载搜索扩展）。
// - 蒸馏 seed（DISTILL_TASK_ID）：仅 cron 可编辑，prompt 只读 + 说明（蒸馏链不消费 prompt——
//   改了不生效的控件=欺骗用户）；displayName/开关禁用；不可新建出第二个蒸馏。
// 交互完整态：提交 busy、失败错误可见（服务端 error 字段直出）、Esc/点外取消无副作用。
import { useEffect, useState } from "react";
import { GlobeHemisphereWestIcon, MagnifyingGlassIcon, PencilSimpleIcon, WarningIcon } from "@phosphor-icons/react";
import { createSystemTask, updateTask, isDistillSeed, type ScheduledTask } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";

const IW = 1.5;

/** cron 粗校验（review P3）：5 段非空即过——合法性与频率下限（≥1h）的精确语义留在服务端单点，前端只挡明显错形。 */
const cronLooksWrong = (cron: string): boolean =>
  cron.trim().length > 0 && cron.trim().split(/\s+/).length !== 5;

/** 开关行：label + 说明 + checkbox（原生——触控面积优先，样式跟 ui 惯例）。 */
function Toggle({
  checked, onChange, disabled, label, hint, testid, icon,
}: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
  label: string; hint: string; testid: string; icon: React.ReactNode;
}) {
  return (
    <label className={`flex items-start gap-2 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-primary"
        data-testid={testid}
      />
      <span className="flex flex-col">
        <span className="flex items-center gap-1 text-xs font-medium text-foreground">
          {icon}
          {label}
        </span>
        <span className="text-[11px] leading-relaxed text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

export function TaskDialog({
  task, onClose, onSaved,
}: {
  task: ScheduledTask | null; // null=新建；行=编辑（蒸馏 seed 按 id 特判形态）
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = task !== null;
  const isDistill = task !== null && isDistillSeed(task); // 冻结特判单出口（review S1）
  const [name, setName] = useState(task?.displayName ?? "");
  const [cron, setCron] = useState(task?.cron ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [allowWrite, setAllowWrite] = useState(task?.allowWrite ?? true);
  const [allowSearch, setAllowSearch] = useState(task?.allowSearch ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // task 引用变化（行切换）重置表单——useState 初值只在挂载取一次
  useEffect(() => {
    setName(task?.displayName ?? "");
    setCron(task?.cron ?? "");
    setPrompt(task?.prompt ?? "");
    setAllowWrite(task?.allowWrite ?? true);
    setAllowSearch(task?.allowSearch ?? false);
    setError(null);
  }, [task]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isEdit && task) {
        // 蒸馏 seed 只送 cron（服务端冻结闸同口径——多余字段会 403）
        await updateTask(task.id, isDistill ? { cron } : { displayName: name, cron, prompt, allowWrite, allowSearch });
      } else {
        await createSystemTask({ displayName: name, cron, prompt, allowWrite, allowSearch });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !busy && cron.trim().length > 0 && !cronLooksWrong(cron) && (isDistill || (name.trim().length > 0 && prompt.trim().length > 0));

  return (
    <Dialog open onClose={onClose} title={isDistill ? "编辑蒸馏任务" : isEdit ? "编辑 system 任务" : "新建 system 任务"}>
      <div className="flex flex-col gap-3" data-testid="task-dialog">
        {/* 范围区：固定徽标——逻辑概念无选择器（ADR-0023 决策 1） */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">执行范围</span>
          <span
            className="inline-flex items-center gap-1 rounded-sm bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
            data-testid="scope-badge"
          >
            <GlobeHemisphereWestIcon size={11} strokeWidth={IW} />
            System（全域）
          </span>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isDistill}
            placeholder="如：周报巡检"
            className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50"
            data-testid="task-form-name"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">触发时间（cron）</span>
          <input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 5 * * 1（分 时 日 月 周；最小间隔 1 小时）"
            className={`h-8 rounded-md border bg-background px-2 font-mono text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/20 ${cronLooksWrong(cron) ? "border-destructive" : "border-input focus-visible:border-ring"}`}
            data-testid="task-form-cron"
          />
          {cronLooksWrong(cron) && (
            <span className="text-[11px] text-destructive" data-testid="cron-format-error">
              格式应为 5 段（分 时 日 月 周），如 0 5 * * 1
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="flex items-center gap-1 text-xs font-medium text-foreground">
            <PencilSimpleIcon size={11} strokeWidth={IW} />
            任务目标（prompt）
          </span>
          {isDistill ? (
            // 蒸馏链不消费 prompt——只读展示 + 一行说明（不欺骗用户）
            <>
              <textarea
                value={prompt}
                disabled
                rows={3}
                className="resize-none rounded-md border border-input bg-secondary/40 px-2 py-1.5 text-xs text-muted-foreground"
                data-testid="task-form-prompt"
              />
              <span className="text-[11px] text-muted-foreground" data-testid="distill-note">
                内置蒸馏链路，不消费 prompt——仅触发频率可调整。
              </span>
            </>
          ) : (
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="任务要完成什么（LLM 无人值守执行）"
              className="resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
              data-testid="task-form-prompt"
            />
          )}
        </label>

        {/* 权限双开关（蒸馏 seed 禁用——特判分支不读这些列） */}
        <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-secondary/20 p-2.5">
          <span className="text-[11px] font-semibold text-muted-foreground">任务权限</span>
          <Toggle
            checked={allowWrite}
            onChange={setAllowWrite}
            disabled={isDistill}
            label="允许写入工作产物"
            hint="关=全域只读运行（防注入写脏共享区）"
            testid="task-form-allowwrite"
            icon={<PencilSimpleIcon size={11} strokeWidth={IW} />}
          />
          {!allowWrite && !isDistill && (
            <span className="flex items-start gap-1 rounded-sm bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive" data-testid="readonly-note">
              <WarningIcon size={12} strokeWidth={IW} className="mt-0.5 shrink-0" />
              严格只读：无法写任何文件（含临时目录），产出仅执行日志。
            </span>
          )}
          <Toggle
            checked={allowSearch}
            onChange={setAllowSearch}
            disabled={isDistill}
            label="允许搜索工具"
            hint="开=LLM 可调用网络搜索（缺省关=纯本地任务）"
            testid="task-form-allowsearch"
            icon={<MagnifyingGlassIcon size={11} strokeWidth={IW} />}
          />
        </div>

        {error && (
          <p className="rounded-sm bg-destructive/10 px-2 py-1.5 text-xs text-destructive" data-testid="task-dialog-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit} data-testid="task-submit">
            {busy ? "保存中…" : isEdit ? "保存" : "创建"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
