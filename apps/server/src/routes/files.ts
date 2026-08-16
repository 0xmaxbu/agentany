// #30/M4-3b 文件服务路由：GET /files/<workspaceId>/<relative_path>。
// 鉴权：登录（auth 中间件全家桶）+ canAccessWorkspace（无权 404 不泄漏——resolveRequestWorkspace 口径）。
// 防逃逸：归一 resolve 后必须仍在 ws cwd 内（wsRelativePath 同一逻辑——收集与读取共用口径）。
// 预览/下载同一端点：?download=1 → attachment；缺省 inline（扩展名路由预览 or 下载由前端决定）。
import { createReadStream, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Hono } from "hono";
import { resolveScopePaths, scopeOf } from "../scope";
import { principalOf, type AppEnv } from "../auth/middleware";
import { canAccessWorkspace } from "../workspaces/guard";
import { assertValidWorkspaceId } from "../config";
import type { RunDeps } from "../runs";

// v1 预览能力扩展名（票面：md/txt/html/pdf 纯文本/PDF 预览；其余前端直接下载）。
const MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
};

export function registerFileRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  app.get("/files/:workspaceId/:path{.+}", (c) => {
    const u = principalOf(c);
    const wsId = c.req.param("workspaceId");
    try {
      assertValidWorkspaceId(wsId);
    } catch {
      return c.json({ error: "invalid workspaceId" }, 400);
    }
    // ws 存在 + 可见（admin 全通 / allUsers / 名单）——无权与不存在同 404
    if (!deps.workspaceStore.getWorkspace(wsId) || !canAccessWorkspace(deps.workspaceStore, wsId, u)) {
      return c.json({ error: "workspace not found" }, 404);
    }
    // 防逃逸：URL path 解码后归一，必须落在 ws cwd 内
    const cwd = resolveScopePaths(scopeOf(wsId), wsId).cwd;
    const rel = c.req.param("path");
    const abs = resolve(cwd, rel);
    if (abs !== cwd && !abs.startsWith(cwd + "/") && !abs.startsWith(cwd + "\\")) {
      return c.json({ error: "file not found" }, 404);
    }
    let size: number;
    try {
      size = statSync(abs).size; // 不存在/非普通文件（目录）→ 404
    } catch {
      return c.json({ error: "file not found" }, 404);
    }

    const name = rel.split("/").pop() ?? "file";
    const mime = MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
    const disposition = c.req.query("download") === "1" ? "attachment" : "inline";
    // 文件名 ASCII fallback（RFC 6266 *）：非 ASCII 名走 filename*，老代理仍可用 fallback
    const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
    const headers = new Headers({
      "content-type": mime,
      "content-disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "content-length": String(size),
    });
    // 流式回（大文件不整读进内存）；手写 Response 须自带 headers（c.header 不进手写 Response）
    const stream = new ReadableStream({
      start(controller) {
        const rs = createReadStream(abs);
        rs.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
        rs.on("end", () => controller.close());
        rs.on("error", (e) => controller.error(e));
      },
    });
    return new Response(stream, { headers });
  });
}
