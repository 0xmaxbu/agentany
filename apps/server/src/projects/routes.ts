// 项目 + 成员管理路由（ADR-0013/0014，步骤 b）。
// 鉴权分层：所有 /projects/:id 先 requireMember（非成员→404 不泄漏存在）；owner 路由再 requireOwner（成员非 owner→403）。
// 复用 auth/middleware 的 userIdOf / AppEnv（身份来自 step a 真 auth）。
import type { Hono } from "hono";
import type { RunDeps } from "../runs";
import { jsonBody } from "../http";
import { userIdOf, type AppEnv } from "../auth/middleware";
import { AlreadyMember, LastOwner, SlugTaken, validSlug, type ProjectRole, type ProjectRow, type MemberRow } from "./store";

const toProject = (p: ProjectRow): Record<string, unknown> => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  description: p.description ?? null,
  ownerId: p.ownerId,
  status: p.status,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});
const toMember = (m: MemberRow): Record<string, unknown> => ({
  userId: m.userId,
  username: m.username,
  displayName: m.displayName ?? null,
  role: m.role,
  createdAt: m.createdAt,
});

export function registerProjectRoutes(app: Hono<AppEnv>, deps: RunDeps): void {
  const ps = deps.projectStore;
  const us = deps.userStore;

  // 项目须存在 + 当前用户是成员 → 返回 project；否则 null（路由统一回 404，不泄漏存在）。
  const loadIfMember = (projectId: string, userId: string): ProjectRow | null => {
    const project = ps.getProject(projectId);
    if (!project || ps.memberRole(projectId, userId) == null) return null;
    return project;
  };

  // 建项目（任何已登录用户；创建者=owner）
  app.post("/projects", async (c) => {
    const body = await jsonBody(c);
    const slug: unknown = body.slug;
    const name: unknown = body.name;
    if (typeof slug !== "string" || !validSlug(slug)) return c.json({ error: "invalid slug" }, 400);
    if (typeof name !== "string" || name.length === 0) return c.json({ error: "name required" }, 400);
    const description = typeof body.description === "string" ? body.description : undefined;
    try {
      const p = ps.createProject({ slug, name, description, ownerId: userIdOf(c) });
      return c.json(toProject(p), 201);
    } catch (e) {
      if (e instanceof SlugTaken) return c.json({ error: "slug taken" }, 409);
      throw e;
    }
  });

  // 列「我是成员」的项目
  app.get("/projects", (c) => c.json(ps.listProjectsForUser(userIdOf(c)).map(toProject)));

  // 项目详情（须成员）
  app.get("/projects/:id", (c) => {
    const p = loadIfMember(c.req.param("id"), userIdOf(c));
    if (!p) return c.json({ error: "project not found" }, 404);
    return c.json(toProject(p));
  });

  // 改名/描述（owner only）
  app.patch("/projects/:id", async (c) => {
    const id = c.req.param("id");
    const userId = userIdOf(c);
    if (!loadIfMember(id, userId)) return c.json({ error: "project not found" }, 404);
    if (ps.memberRole(id, userId) !== "owner") return c.json({ error: "forbidden" }, 403);
    const body = await jsonBody(c);
    const patch: { name?: string; description?: string } = {};
    if (typeof body.name === "string" && body.name.length > 0) patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    const updated = ps.updateProject(id, patch);
    return c.json(toProject(updated!));
  });

  // 加成员（owner only；userId 须存在）
  app.post("/projects/:id/members", async (c) => {
    const id = c.req.param("id");
    const userId = userIdOf(c);
    if (!loadIfMember(id, userId)) return c.json({ error: "project not found" }, 404);
    if (ps.memberRole(id, userId) !== "owner") return c.json({ error: "forbidden" }, 403);
    const body = await jsonBody(c);
    const targetUserId: unknown = body.userId;
    if (typeof targetUserId !== "string") return c.json({ error: "userId required" }, 400);
    if (!us.getUserById(targetUserId)) return c.json({ error: "user not found" }, 404);
    const rawRole: unknown = body.role ?? "member";
    if (rawRole !== "owner" && rawRole !== "member") return c.json({ error: "role must be 'owner' or 'member'" }, 400);
    const role: ProjectRole = rawRole;
    try {
      ps.addMember(id, targetUserId, role);
    } catch (e) {
      if (e instanceof AlreadyMember) return c.json({ error: "already a member" }, 409);
      throw e;
    }
    return c.json({ ok: true }, 201);
  });

  // 成员列表（须成员）
  app.get("/projects/:id/members", (c) => {
    const id = c.req.param("id");
    if (!loadIfMember(id, userIdOf(c))) return c.json({ error: "project not found" }, 404);
    return c.json(ps.listMembers(id).map(toMember));
  });

  // 移除成员（owner 可移任何人；非 owner 只能移自己；最后 owner 不可移）
  app.delete("/projects/:id/members/:userId", (c) => {
    const id = c.req.param("id");
    const userId = userIdOf(c);
    const target = c.req.param("userId");
    if (!loadIfMember(id, userId)) return c.json({ error: "project not found" }, 404);
    if (ps.memberRole(id, userId) !== "owner" && target !== userId) return c.json({ error: "forbidden" }, 403);
    try {
      ps.removeMember(id, target);
    } catch (e) {
      if (e instanceof LastOwner) return c.json({ error: "cannot remove the last owner" }, 409);
      throw e;
    }
    return c.json({ ok: true });
  });
}
