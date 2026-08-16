// 文件预览页（#30/M4-3b）：/files/:workspaceId/*（产出文件点击进）。
// 顶部：文件名 + 返回 + 下载按钮（fetch+blob 保 Bearer——<a href> 带不上 Authorization）。
// 扩展名路由：md/txt/html/pdf → 预览（md 走 ReactMarkdown、html 走 iframe sandbox 防 XSS、pdf 走
// blob URL iframe）；其余 → 挂载即自动下载（无预览能力，票面：直接下载）。
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeftIcon, DownloadIcon, FileIcon, WarningIcon } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchFile } from "../api";
import { Button } from "../components/ui/button";

const IW = 1.5;
/** v1 可预览扩展名（票面：md/txt/html/pdf 纯文本/PDF 预览；其余直接下载）。 */
const PREVIEWABLE = new Set(["md", "txt", "html", "htm", "pdf"]);
const extOf = (name: string): string => name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";

const DownloadButton = ({ workspaceId, path, name }: { workspaceId: string; path: string; name: string }) => {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const r = await fetchFile(workspaceId, path, true); // ?download=1 → attachment
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url); // 同 tick revoke：Safari 亦可（click 已同步触发导航）
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="outline" onClick={() => void download()} disabled={busy}>
      <DownloadIcon size={14} weight="light" strokeWidth={IW} />
      下载
    </Button>
  );
};

export function FilePreviewPage() {
  const params = useParams<{ workspaceId: string; "*"?: string }>();
  const workspaceId = params.workspaceId ?? "";
  const path = params["*"] ?? "";
  const name = path.split("/").pop() ?? "file";
  const ext = extOf(name);
  const previewable = PREVIEWABLE.has(ext);

  const [text, setText] = useState<string | null>(null); // md/txt/html 源文本
  const [blobUrl, setBlobUrl] = useState<string | null>(null); // pdf blob
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setText(null);
    setBlobUrl(null);
    setError(null);
    (async () => {
      try {
        const r = await fetchFile(workspaceId, path); // inline（预览源）
        if (!alive) return;
        if (r.status === 404) {
          setError("文件不存在或无权访问");
          return;
        }
        if (!r.ok) {
          setError(`加载失败（${r.status}）`);
          return;
        }
        if (ext === "pdf") {
          objectUrl = URL.createObjectURL(await r.blob());
          if (alive) setBlobUrl(objectUrl);
        } else if (previewable) {
          if (alive) setText(await r.text());
        } else {
          // 无预览能力（按扩展名路由）→ 直接下载后返回上一页
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          a.click();
          URL.revokeObjectURL(url);
        }
      } catch {
        if (alive) setError("网络错误");
      }
    })();
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspaceId, path, ext, previewable, name]);

  const body = useMemo(() => {
    if (error) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <WarningIcon size={28} weight="light" strokeWidth={IW} className="text-destructive" />
          <span>{error}</span>
        </div>
      );
    }
    if (ext === "pdf") {
      return blobUrl ? (
        <iframe title={name} src={blobUrl} className="h-full w-full flex-1 border-0" />
      ) : null;
    }
    if (ext === "html" || ext === "htm") {
      // sandbox 无 allow-scripts：html 产出按纯渲染文档预览，不执行脚本（XSS 收口）
      return text != null ? (
        <iframe title={name} sandbox="" srcDoc={text} className="h-full w-full flex-1 border-0 bg-white" />
      ) : null;
    }
    if (ext === "md") {
      return (
        <div className="flex-1 overflow-auto">
          <div className="md mx-auto max-w-3xl px-6 py-4">
            {text != null ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown> : null}
          </div>
        </div>
      );
    }
    if (ext === "txt") {
      return (
        <pre className="flex-1 overflow-auto whitespace-pre-wrap px-6 py-4 font-mono text-[13px] leading-relaxed">
          {text ?? ""}
        </pre>
      );
    }
    // 无预览能力：自动下载已触发
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileIcon size={28} weight="light" strokeWidth={IW} />
        <span>该文件类型无预览，已开始下载…</span>
      </div>
    );
  }, [error, blobUrl, text, ext, name]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Link to=".." relative="path" className="flex items-center gap-1 rounded px-1 py-0.5 text-sm text-muted-foreground hover:bg-accent">
          <ArrowLeftIcon size={15} weight="light" strokeWidth={IW} />
          返回
        </Link>
        <span className="truncate text-sm font-medium" title={path}>{name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{path}</span>
        <span className="ml-auto shrink-0">
          <DownloadButton workspaceId={workspaceId} path={path} name={name} />
        </span>
      </header>
      {body}
    </div>
  );
}
