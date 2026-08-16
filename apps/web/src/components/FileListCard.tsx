// FileListCard（#30/M4-3b）：产出消息尾的文件列表卡（文件管理器式——文件名/时间，点击进预览）。
// 数据锚：task_files 分组的 outputMessageId == 该消息 id（实时流 id=null 落定后匹配；DB 兜底源 id 是数字）。
import { FileIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import type { TaskFileGroup } from "../api";

const IW = 1.5;
const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** 产出文件预览路由（workspaceId 从当前会话上下文取——产出会话挂任务同 ws）。 */
export const filePreviewPath = (workspaceId: string, path: string): string =>
  `/files/${encodeURIComponent(workspaceId)}/${path.split("/").map(encodeURIComponent).join("/")}`;

export function FileListCard({ group, workspaceId }: { group: TaskFileGroup; workspaceId: string }) {
  if (group.files.length === 0) return null;
  return (
    <Card className="my-2 border-border bg-secondary/40 text-[13px]">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 opacity-80">
          <FileIcon size={14} weight="light" strokeWidth={IW} />
          <span>本次产出文件（{group.files.length}）</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="mt-1 flex flex-col gap-0.5">
          {group.files.map((f) => (
            <li key={f.id}>
              <Link
                to={filePreviewPath(workspaceId, f.path)}
                className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-accent"
                title={f.path}
              >
                <FileIcon size={13} weight="light" strokeWidth={IW} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{f.name}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{fmtTime(f.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** 消息尾文件组（ChatWindow 用）：匹配 outputMessageId（DB 源数字 id / pi session 源字符串 id 双比）。 */
export const groupForMessage = (groups: TaskFileGroup[], messageId: number | null): TaskFileGroup | undefined =>
  messageId == null ? undefined : groups.find((g) => String(g.outputMessageId) === String(messageId));
