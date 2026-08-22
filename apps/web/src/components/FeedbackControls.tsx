// #34/M5-1 反馈控件（两粒度）：
// - MessageFeedback：assistant 气泡尾部 👍/👎（Phosphor，点击即提交 rating 5/1；已点高亮；
//   展开可补可选备注再提交）。回显拉全量后取本人最新一条（v1 无按人过滤端点——本人会话即本人反馈，
//   admin 可见他全部，展开态可见明细即可）。
// - RunFeedback：run 卡内批注 + 1-5 评分（展开表单；提交后回显只读）。
// 交互纪律：轻量优先——不弹层、不打断；反馈失败静默（console）不扰主流程。
import { useEffect, useState } from "react";
import { ChatTextIcon, ThumbsDownIcon, ThumbsUpIcon } from "@phosphor-icons/react";
import {
  getMessageFeedback, getRunFeedback, rateMessage, rateRun, type FeedbackRow,
} from "../api";
import { Button } from "./ui/button";
import { useAuth } from "../store/auth";

const IW = 1.5;

/** 消息级：👍/👎 + 可选备注。 */
export function MessageFeedback({ messageId }: { messageId: string | number }) {
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [mine, setMine] = useState<FeedbackRow | null>(null); // 本人最新一条（高亮锚）
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const me = useAuth((s) => s.user);

  /** 本人最新一条（按 authorId 过滤——admin 看他人会话不误高亮；旧行 null 按末条回退）。单处维护（审查 Std-9）。 */
  const mineFrom = (list: FeedbackRow[]): FeedbackRow | null => {
    if (!list.length) return null;
    const mineRows = list.filter((r) => r.authorId == null || r.authorId === me?.id);
    const last = mineRows[mineRows.length - 1];
    return last && (last.rating === 5 || last.rating === 1) ? last : null;
  };

  useEffect(() => {
    void getMessageFeedback(messageId).then((r) => { setRows(r); setMine(mineFrom(r)); }).catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, me?.id]);

  const rate = async (up: boolean, withNote?: string) => {
    setBusy(true);
    try {
      await rateMessage(messageId, up, withNote);
      const fresh = await getMessageFeedback(messageId).catch(() => [] as FeedbackRow[]);
      setRows(fresh);
      setMine(mineFrom(fresh));
      setExpanded(false);
      setNote("");
    } catch (e) {
      console.warn("feedback failed", e);
    } finally {
      setBusy(false);
    }
  };

  /** 备注提交的方向：保持本人已点的方向；从未点过则默认 👍（显式化原 `up || !down` 晦涩式）。 */
  const noteDirection = (): boolean => mine?.rating !== 1;

  const up = mine?.rating === 5;
  const down = mine?.rating === 1;

  return (
    <div className="mt-1 flex items-center gap-1.5" data-testid="msg-feedback">
      <button
        title="有帮助"
        disabled={busy}
        onClick={() => void rate(true)}
        className={`rounded p-1 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${up ? "text-primary" : "text-muted-foreground"}`}
        data-testid="thumb-up"
      >
        <ThumbsUpIcon size={14} strokeWidth={IW} weight={up ? "fill" : "regular"} />
      </button>
      <button
        title="没帮助"
        disabled={busy}
        onClick={() => void rate(false)}
        className={`rounded p-1 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${down ? "text-destructive" : "text-muted-foreground"}`}
        data-testid="thumb-down"
      >
        <ThumbsDownIcon size={14} strokeWidth={IW} weight={down ? "fill" : "regular"} />
      </button>
      <button
        title="写备注"
        onClick={() => setExpanded((v) => !v)}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="feedback-note-toggle"
      >
        <ChatTextIcon size={14} strokeWidth={IW} />
      </button>
      {mine?.text ? (
        <span className="max-w-64 truncate text-[11px] text-muted-foreground" title={mine.text}>{mine.text}</span>
      ) : null}
      {expanded && (
        <span className="reveal flex items-center gap-1">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="可选备注…"
            className="h-7 w-44 rounded-md border border-input bg-background px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
            data-testid="feedback-note-input"
          />
          <Button
            variant="outline" className="h-7 px-2 text-xs" disabled={busy || !note.trim()}
            onClick={() => void rate(noteDirection(), note.trim())}
            data-testid="feedback-note-submit"
          >
            提交
          </Button>
        </span>
      )}
    </div>
  );
}

/** run 级：批注 + 1-5 评分（展开表单；回显只读）。 */
export function RunFeedback({ runId }: { runId: string }) {
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [rating, setRating] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = () => void getRunFeedback(runId).then(setRows).catch(() => setRows([]));
  useEffect(load, [runId]);

  const submit = async () => {
    setBusy(true);
    try {
      await rateRun(runId, text.trim(), rating);
      setText(""); setRating(undefined); setOpen(false);
      load();
    } catch (e) {
      console.warn("run feedback failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5" data-testid="run-feedback">
      {rows && rows.length > 0 ? (
        <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          {rows.slice(-2).reverse().map((r) => (
            <span key={r.id} className="truncate">
              批注：{r.text || "-"}{r.rating != null ? ` · ${r.rating}/5` : ""}
            </span>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="reveal mt-1 flex flex-wrap items-center gap-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="对这次执行的批注…"
            className="h-7 min-w-40 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
            data-testid="run-feedback-text"
          />
          <select
            value={rating ?? ""}
            onChange={(e) => setRating(e.target.value ? Number(e.target.value) : undefined)}
            className="h-7 rounded-md border border-input bg-background px-1 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
            data-testid="run-feedback-rating"
          >
            <option value="">不评分</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <Button variant="outline" className="h-7 px-2 text-xs" disabled={busy || !text.trim()} onClick={() => void submit()} data-testid="run-feedback-submit">
            提交
          </Button>
          <button className="rounded px-0.5 text-[11px] text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setOpen(false)}>取消</button>
        </div>
      ) : (
        <button className="rounded px-0.5 text-[11px] text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setOpen(true)} data-testid="run-feedback-open">
          批注这次执行
        </button>
      )}
    </div>
  );
}
