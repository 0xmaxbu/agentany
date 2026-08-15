// 工作空间路由（ADR-0018）：建/列/查/改名/名单管理。建与管 = admin only；查 = canAccessWorkspace。
import type { Hono } from "hono";
import type { RunDeps } from "../runs";
import { userRoleOf, principalOf, type AppEnv } from "../auth/middleware";
import { canAccessWorkspace } from "../workspaces/guard";
import { AlreadyMember, COMPANY_WORKSPACE_ID, SlugTaken, validSlug, type WorkspaceRow, type WsMemberRow } from "../workspaces/store";
import { jsonBody } from "../http";

const toWorkspace = (w: WorkspaceRow): Record<string, unknown> => ({
  id: w.id,
  slug: w.slug,
  name: w.name,
  allUsers: w.allUsers,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt,
  archivedAt: w.archivedAt ?? null, // #手风琴：管理页 switch 状态
});
const toMember = (m: WsMemberRow): Record<string, unknown> => ({
  userId: m.userId,
  username: m.username,
  displayName: m.displayName,
  createdAt: m.createdAt,
});

export function registerWorkspaceRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  const ws = deps.workspaceStore;
  const us = deps.userStore;

  // 建 ws（admin only）。f4：slug 可缺省——后端自动生成（短随机尾防碰撞；slug 无路由用途，只是
  // UNIQUE 显示/检索名——管理页表单不暴露）；显式提供仍校验（脚本/迁移路径）。
  app.post("/workspaces", async (c) => {
    if (userRoleOf(c) !== "admin") return c.json({ error: "forbidden" }, 403);
    const body = await jsonBody(c);
    const name: unknown = body.name;
    if (typeof name !== "string" || name.length === 0) return c.json({ error: "name required" }, 400);
    const slugProvided: unknown = body.slug;
    const autoSlug = (): string => `ws-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    let slug: string;
    if (slugProvided === undefined) {
      slug = autoSlug();
    } else if (typeof slugProvided !== "string" || !validSlug(slugProvided)) {
      return c.json({ error: "invalid slug" }, 400);
    } else {
      slug = slugProvided;
    }
    const allUsers = body.allUsers === true;
    const memberIds: unknown = body.memberIds ?? [];
    if (!Array.isArray(memberIds) || memberIds.some((m) => typeof m !== "string")) {
      return c.json({ error: "memberIds must be string[]" }, 400);
    }
    for (const userId of memberIds) {
      if (!us.getUserById(userId as string)) return c.json({ error: "user not found" }, 404);
    }
    try {
      const w = ws.createWorkspace({ slug, name, allUsers, memberIds: memberIds as string[] });
      return c.json(toWorkspace(w), 201);
    } catch (e) {
      if (e instanceof SlugTaken && slugProvided === undefined) {
        // 随机尾碰撞（概率 ~1/4亿）——重试一次
        const w = ws.createWorkspace({ slug: autoSlug(), name, allUsers, memberIds: memberIds as string[] });
        return c.json(toWorkspace(w), 201);
      }
      if (e instanceof SlugTaken) return c.json({ error: "slug taken" }, 409);
      throw e;
    }
  });

  // 列：普通用户 = allUsers ∪ 名单内；admin = 全部
  // 列（#手风琴）：默认滤归档；?archived=1 反向（管理页恢复入口）。每项附该用户视角的
  // lastActiveAt/conversationCount（侧栏排序锚——只算自己的会话，跨用户活跃不泄漏）。
  app.get("/workspaces", (c) => {
    const archived = c.req.query("archived") === "1";
    const isAdmin = userRoleOf(c) === "admin";
    const list = isAdmin ? ws.listAllWorkspaces(archived) : ws.listWorkspacesForUser(principalOf(c).id, archived);
    const activity = ws.activityByWorkspace(principalOf(c).id, list.map((w) => w.id));
    return c.json(list.map((w) => {
      const a = activity.get(w.id);
      return { ...toWorkspace(w), archivedAt: w.archivedAt, lastActiveAt: a?.lastActiveAt ?? null, conversationCount: a?.conversationCount ?? 0 };
    }));
  });

  // 详情 + 名单（须 canAccess；存在性独立于 admin 全通——不存在的 id 一律 404，不吃 500）
  app.get("/workspaces/:id", (c) => {
    const id = c.req.param("id");
    const w = ws.getWorkspace(id);
    if (!w || !canAccessWorkspace(ws, id, principalOf(c))) {
      return c.json({ error: "workspace not found" }, 404);
    }
    return c.json({ ...toWorkspace(w), members: ws.listMembers(id).map(toMember) });
  });

  // 改名/全员位（admin only）
  app.patch("/workspaces/:id", async (c) => {
    const id = c.req.param("id");
    if (userRoleOf(c) !== "admin") return c.json({ error: "forbidden" }, 403);
    if (!ws.getWorkspace(id)) return c.json({ error: "workspace not found" }, 404);
    const body = await jsonBody(c);
    const patch: { name?: string; allUsers?: boolean } = {};
    if (typeof body.name === "string" && body.name.length > 0) patch.name = body.name;
    if (typeof body.allUsers === "boolean") patch.allUsers = body.allUsers;
    const updated = ws.updateWorkspace(id, patch);
    return c.json(toWorkspace(updated!));
  });

  // 加名单（admin only；userId 须存在）
  app.post("/workspaces/:id/members", async (c) => {
    const id = c.req.param("id");
    if (userRoleOf(c) !== "admin") return c.json({ error: "forbidden" }, 403);
    if (!ws.getWorkspace(id)) return c.json({ error: "workspace not found" }, 404);
    const body = await jsonBody(c);
    const targetUserId: unknown = body.userId;
    if (typeof targetUserId !== "string") return c.json({ error: "userId required" }, 400);
    if (!us.getUserById(targetUserId)) return c.json({ error: "user not found" }, 404);
    try {
      ws.addMember(id, targetUserId);
    } catch (e) {
      if (e instanceof AlreadyMember) return c.json({ error: "already a member" }, 409);
      throw e;
    }
    return c.json({ ok: true }, 201);
  });

  // 移出名单（admin only；幂等）
  app.delete("/workspaces/:id/members/:userId", (c) => {
    const id = c.req.param("id");
    if (userRoleOf(c) !== "admin") return c.json({ error: "forbidden" }, 403);
    if (!ws.getWorkspace(id)) return c.json({ error: "workspace not found" }, 404);
    ws.removeMember(id, c.req.param("userId"));
    return c.json({ ok: true });
  });

  // ── #手风琴：ws 归档/恢复（admin；幂等）。语义=侧栏隐藏，其会话可看可发（整理动作非封禁）。 ──
  app.patch("/workspaces/:id/archive", (c) => {
    if (userRoleOf(c) !== "admin") return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    if (id === COMPANY_WORKSPACE_ID) return c.json({ error: "company workspace cannot be archived" }, 400); // 系统锚：砍它=砍缺省会话入口
    const row = ws.archiveWorkspace(id);
    if (!row) return c.json({ error: "workspace not found" }, 404);
    return c.json(toWorkspace(row));
  });

  app.patch("/workspaces/:id/restore", (c) => {
    if (userRoleOf(c) !== "admin") return c.json({ error: "forbidden" }, 403);
    const row = ws.restoreWorkspace(c.req.param("id"));
    if (!row) return c.json({ error: "workspace not found" }, 404);
    return c.json(toWorkspace(row));
  });
}
