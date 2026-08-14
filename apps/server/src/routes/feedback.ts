// 反馈路由（ADR-0008 持续学习闭环）。多态：/feedback/<targetKind>/<targetId>。
import type { Hono } from "hono";
import type { AppEnv } from "../auth/middleware";
import type { RunDeps } from "../runs";
import { jsonBody } from "../http";

export function registerFeedbackRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  app.post("/feedback/:targetKind/:targetId", async (c) => {
    const { targetKind, targetId } = c.req.param();
    const body = await jsonBody(c);
    const text: string | undefined = body.text;
    const rating: number | undefined = body.rating;
    if (!text || typeof text !== "string") return c.json({ error: "text required" }, 400);
    if (rating !== undefined && (typeof rating !== "number" || rating < 1 || rating > 5))
      return c.json({ error: "rating must be 1-5" }, 400);
    const id = deps.store.addFeedback({ targetKind, targetId, text, rating });
    return c.json({ id, targetKind, targetId }, 201);
  });

  app.get("/feedback/:targetKind/:targetId", (c) => {
    const { targetKind, targetId } = c.req.param();
    return c.json(deps.store.getFeedback(targetKind, targetId));
  });
}
