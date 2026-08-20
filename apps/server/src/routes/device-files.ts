// 远端工具文件回传（ADR-0033 / R-5 决策 3）：设备经认证 HTTP 上传到该 run 的工作区（落 runId 目录），
// tool_result.artifacts[].path = 相对路径（pi / 文件预览区无感取回）。设备凭 R-2 用户 token 上传
// （auth 中间件解析真实身份）；归属校验：uploader 必须为该 run 会话所有者（远端转发只出现在会话 run）。
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Hono } from "hono";
import type { RunDeps } from "../runs";
import { type AppEnv, userIdOf } from "../auth/middleware";
import { resolveScopePaths, scopeOf } from "../scope";

export function registerDeviceFileRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  app.post("/files/device-upload", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "multipart form required" }, 400);
    const runId = String(form.get("runId") ?? "");
    const file = form.get("file");
    if (!runId || !(file instanceof File)) return c.json({ error: "runId and file required" }, 400);
    // 文件名消毒：取 basename 防路径穿越；空 → 拒
    const name = basename(file.name);
    if (!name || name === "." || name === "..") return c.json({ error: "invalid filename" }, 400);

    const run = deps.runStore.getRun(runId);
    if (!run) return c.json({ error: "run not found" }, 404);
    if (!run.conversationId) return c.json({ error: "run has no conversation (remote tools only in conversation runs)" }, 403);
    const conv = deps.chatStore.getConversation(run.conversationId);
    if (!conv || conv.userId !== userIdOf(c)) return c.json({ error: "uploader is not run owner" }, 403);

    const { cwd } = resolveScopePaths(scopeOf(run.workspaceId), run.workspaceId);
    const dir = join(cwd, "runs", runId);
    mkdirSync(dir, { recursive: true });
    const bytes = new Uint8Array(await file.arrayBuffer());
    writeFileSync(join(dir, name), bytes);
    const rel = join("runs", runId, name);
    return c.json({ path: rel, name, size: bytes.byteLength });
  });
}