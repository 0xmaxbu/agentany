// 项目 + 项目成员数据访问（ADR-0013/0014，步骤 b）。照搬 UserStore/WorkflowStore：本域唯一耦合 db。
// createProject 用 db.transaction 原子插 project + owner 成员（本仓首处用事务，保「项目必有 owner」不变量）。
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { projectMembers, projects, users } from "../db/schema";

const now = (): string => new Date().toISOString();
const newProjectId = (): string => "p_" + globalThis.crypto.randomUUID();

export type ProjectRole = "owner" | "member";
export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  ownerId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface MemberRow {
  userId: string;
  username: string;
  displayName: string | null;
  role: ProjectRole;
  createdAt: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const validSlug = (slug: string): boolean => SLUG_RE.test(slug);

export class SlugTaken extends Error {
  constructor(slug: string) {
    super(`slug taken: ${slug}`);
    this.name = "SlugTaken";
  }
}
export class AlreadyMember extends Error {
  constructor() {
    super("already a member");
    this.name = "AlreadyMember";
  }
}
export class LastOwner extends Error {
  constructor() {
    super("cannot remove the last owner");
    this.name = "LastOwner";
  }
}

// 只认 UNIQUE 冲突——NOT NULL/FK/PK 同属 SQLITE_CONSTRAINT*，不能一并吞掉（审计收紧）
const isUniqueError = (e: any): boolean =>
  String(e?.code ?? "").includes("UNIQUE") || /UNIQUE constraint failed/i.test(String(e?.message ?? ""));

const projectCols = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  description: projects.description,
  ownerId: projects.ownerId,
  status: projects.status,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};
const toProjectRow = (r: any): ProjectRow => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description ?? null,
  ownerId: r.ownerId,
  status: r.status,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export class ProjectStore {
  constructor(private db: BunSQLiteDatabase<any>) {}

  /** 建项目 + 创建者为 owner 成员（事务原子）。slug UNIQUE 冲突 → SlugTaken。 */
  createProject(p: { slug: string; name: string; description?: string; ownerId: string }): ProjectRow {
    const id = newProjectId();
    const ts = now();
    const row: ProjectRow = {
      id,
      slug: p.slug,
      name: p.name,
      description: p.description ?? null,
      ownerId: p.ownerId,
      status: "active",
      createdAt: ts,
      updatedAt: ts,
    };
    try {
      this.db.transaction((tx) => {
        tx.insert(projects).values(row).run();
        tx.insert(projectMembers).values({ projectId: id, userId: p.ownerId, role: "owner", createdAt: ts }).run();
      });
    } catch (e: any) {
      if (isUniqueError(e)) throw new SlugTaken(p.slug);
      throw e;
    }
    return row;
  }

  getProject(id: string): ProjectRow | null {
    const r = this.db.select(projectCols).from(projects).where(eq(projects.id, id)).all()[0];
    return r ? toProjectRow(r) : null;
  }

  getProjectBySlug(slug: string): ProjectRow | null {
    const r = this.db.select(projectCols).from(projects).where(eq(projects.slug, slug)).all()[0];
    return r ? toProjectRow(r) : null;
  }

  listProjectsForUser(userId: string): ProjectRow[] {
    return this.db
      .select(projectCols)
      .from(projects)
      .innerJoin(projectMembers, eq(projects.id, projectMembers.projectId))
      .where(and(eq(projectMembers.userId, userId), eq(projects.status, "active")))
      .orderBy(projects.createdAt)
      .all()
      .map(toProjectRow);
  }

  updateProject(id: string, patch: { name?: string; description?: string }): ProjectRow | null {
    const set: Record<string, unknown> = { updatedAt: now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    const r = this.db.update(projects).set(set).where(eq(projects.id, id)).run();
    if (!((r as any).changes ?? 0)) return null;
    return this.getProject(id);
  }

  /** 成员角色（鉴权守卫用）；非成员 → null。 */
  memberRole(projectId: string, userId: string): ProjectRole | null {
    const r = this.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .all()[0];
    return (r?.role as ProjectRole) ?? null;
  }

  /** 成员列表（join users 出 username/displayName）。 */
  listMembers(projectId: string): MemberRow[] {
    return this.db
      .select({
        userId: projectMembers.userId,
        username: users.username,
        displayName: users.displayName,
        role: projectMembers.role,
        createdAt: projectMembers.createdAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(projectMembers.userId, users.id))
      .where(eq(projectMembers.projectId, projectId))
      .all()
      .map((r: any) => ({ userId: r.userId, username: r.username, displayName: r.displayName ?? null, role: r.role, createdAt: r.createdAt }));
  }

  /** 加成员；UNIQUE 冲突（已成员）→ AlreadyMember。 */
  addMember(projectId: string, userId: string, role: ProjectRole): void {
    try {
      this.db.insert(projectMembers).values({ projectId, userId, role, createdAt: now() }).run();
    } catch (e: any) {
      if (isUniqueError(e)) throw new AlreadyMember();
      throw e;
    }
  }

  /** 移除成员；最后 owner 不可移（防项目无主）。幂等（非成员→无操作）。check+delete 包事务（审计加固：DB 层原子）。 */
  removeMember(projectId: string, userId: string): void {
    this.db.transaction((tx) => {
      const role = tx
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
        .all()[0]?.role ?? null;
      if (role === "owner") {
        const owners = tx
          .select({ id: projectMembers.id })
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "owner")))
          .all().length;
        if (owners <= 1) throw new LastOwner(); // 抛出 → tx 回滚（本无写，语义等价但路径统一）
      }
      tx.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId))).run();
    });
  }
}
