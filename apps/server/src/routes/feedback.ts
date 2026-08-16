// 反馈路由（ADR-0008 持续学习闭环；#34/M5-1 两粒度+权限+放宽）。
// 多态挂载白名单：message（消息级 👍/👎，targetId=messageId）/ workflow_run（run 级批注评分）/
// chat（会话级——ADR-0008 老语义保留）。
// 权限口径与文件路由一致：挂载目标反查会话 → canAccessConversation（member 只见自己、admin 全通）；
// 不可见/不存在一律 404（不泄漏）。
import type { Hono } from "hono";
import type { AppEnv } from "../auth/middleware";
import { principalOf } from "../auth/middleware";
import type { RunDeps } from "../runs";
import { canAccessConversation } from "../workspaces/guard";
import { jsonBody } from "../http";

const ALLOWED_KINDS = new Set(["message", "workflow_run", "chat"]);

/** targetKind/targetId → 挂载目标所属会话（权限锚点）。查不到 → null（404）。 */
function targetConversation(
  deps: RunDeps, kind: string, targetId: string,
): { id: string; userId: string } | null {
  if (kind === "message") {
    const convId = deps.store.conversationIdOfMessage(targetId);
    if (!convId) return null;
    return deps.store.getConversation(convId) ?? null;
  }
  if (kind === "workflow_run") {
    const convId = deps.store.conversationIdOfRun(targetId);
    if (!convId) return null;
    return deps.store.getConversation(convId) ?? null;
  }
  // chat：targetId 即 conversationId
  return deps.store.getConversation(targetId) ?? null;
}

export function registerFeedbackRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  app.post("/feedback/:targetKind/:targetId", async (c) => {
    const { targetKind, targetId } = c.req.param();
    if (!ALLOWED_KINDS.has(targetKind)) return c.json({ error: "unsupported targetKind" }, 400);
    const conv = targetConversation(deps, targetKind, targetId);
    if (!conv || !canAccessConversation(conv, principalOf(c))) return c.json({ error: "not found" }, 404);
    const body = await jsonBody(c);
    const text: string | undefined = body.text;
    const rating: number | undefined = body.rating;
    // #34 放宽：text 与 rating 至少其一（消息级 👍/👎 只带 rating）
    if ((text === undefined || text === "") && rating === undefined) {
      return c.json({ error: "text or rating required" }, 400);
    }
    if (text !== undefined && typeof text !== "string") return c.json({ error: "text must be string" }, 400);
    if (rating !== undefined && (typeof rating !== "number" || rating < 1 || rating > 5)) {
      return c.json({ error: "rating must be 1-5" }, 400);
    }
    const id = deps.store.addFeedback({ targetKind, targetId, text: text ?? "", rating });
    return c.json({ id, targetKind, targetId }, 201);
  });

  app.get("/feedback/:targetKind/:targetId", (c) => {
    const { targetKind, targetId } = c.req.param();
    if (!ALLOWED_KINDS.has(targetKind)) return c.json({ error: "unsupported targetKind" }, 400);
    const conv = targetConversation(deps, targetKind, targetId);
    if (!conv || !canAccessConversation(conv, principalOf(c))) return c.json({ error: "not found" }, 404);
    return c.json(deps.store.getFeedback(targetKind, targetId));
  });
}
