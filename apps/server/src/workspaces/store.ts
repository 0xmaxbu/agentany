// 工作空间数据访问（ADR-0018）。照搬 UserStore/WorkspaceStore 体例：本域唯一耦合 db。
// 权限 = allUsers ∪ 名单（读时 join users 过滤 active——注销用户悬空行留作审计，不清理）。
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { users, workspaceMembers, workspaces } from "../db/schema";

const now = (): string => new Date().toISOString();
const newWorkspaceId = (): string => "ws_" + globalThis.crypto.randomUUID();

/** 公司默认 workspace：固定 id（迁移 seed；目录锚=data/general）。 */
export const COMPANY_WORKSPACE_ID = "ws_company";

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  allUsers: boolean;
  status: string;
  createdAt: string;
  updatedAt: string;
}
export interface WsMemberRow {
  userId: string;
  username: string;
  displayName: string | null;
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

// 只认 UNIQUE 冲突——NOT NULL/FK/PK 同属 SQLITE_CONSTRAINT*，不能一并吞掉
const isUniqueError = (e: any): boolean =>
  String(e?.code ?? "").includes("UNIQUE") || /UNIQUE constraint failed/i.test(String(e?.message ?? ""));

const wsCols = {
  id: workspaces.id,
  slug: workspaces.slug,
  name: workspaces.name,
  allUsers: workspaces.allUsers,
  status: workspaces.status,
  createdAt: workspaces.createdAt,
  updatedAt: workspaces.updatedAt,
};
const toRow = (r: any): WorkspaceRow => ({
  id: r.id, slug: r.slug, name: r.name, allUsers: !!r.allUsers,
  status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

export class WorkspaceStore {
  constructor(private db: BunSQLiteDatabase<any>) {}

  getWorkspace(id: string): WorkspaceRow | null {
    const r = this.db.select(wsCols).from(workspaces).where(eq(workspaces.id, id)).all()[0];
    return r ? toRow(r) : null;
  }

  /** 建 ws + 初始名单（事务原子）。slug UNIQUE 冲突 → SlugTaken。memberIds 须已校验存在（路由层）。 */
  createWorkspace(p: { slug: string; name: string; allUsers?: boolean; memberIds?: string[] }): WorkspaceRow {
    const id = newWorkspaceId();
    const ts = now();
    const row: WorkspaceRow = {
      id, slug: p.slug, name: p.name, allUsers: p.allUsers ?? false,
      status: "active", createdAt: ts, updatedAt: ts,
    };
    try {
      this.db.transaction((tx) => {
        tx.insert(workspaces).values(row).run();
        // 去重：重复 userId 若不去重会触发名单 UNIQUE 冲突、被下方误判成 SlugTaken
        for (const userId of new Set(p.memberIds ?? [])) {
          tx.insert(workspaceMembers).values({ workspaceId: id, userId, createdAt: ts }).run();
        }
      });
    } catch (e: any) {
      if (isUniqueError(e)) throw new SlugTaken(p.slug);
      throw e;
    }
    return row;
  }

  updateWorkspace(id: string, patch: { name?: string; allUsers?: boolean }): WorkspaceRow | null {
    const set: Record<string, unknown> = { updatedAt: now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.allUsers !== undefined) set.allUsers = patch.allUsers;
    const r = this.db.update(workspaces).set(set).where(eq(workspaces.id, id)).run();
    if (!((r as any).changes ?? 0)) return null;
    return this.getWorkspace(id);
  }

  /** 用户可见：allUsers 的 ∪ 名单内的（join 过滤 active——注销用户名单失效）。v1 无 ws 停用端点，status 不参与过滤（ADR-0018）。 */
  listWorkspacesForUser(userId: string): WorkspaceRow[] {
    const listed = this.db
      .select(wsCols)
      .from(workspaces)
      .innerJoin(workspaceMembers, eq(workspaces.id, workspaceMembers.workspaceId))
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(and(eq(workspaceMembers.userId, userId), eq(users.status, "active")))
      .all().map(toRow);
    const open = this.db
      .select(wsCols)
      .from(workspaces)
      .where(eq(workspaces.allUsers, true))
      .all().map(toRow);
    const seen = new Set<string>();
    return [...open, ...listed].filter((w) => (seen.has(w.id) ? false : (seen.add(w.id), true)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** admin 用：全部。 */
  listAllWorkspaces(): WorkspaceRow[] {
    return this.db.select(wsCols).from(workspaces).orderBy(workspaces.createdAt).all().map(toRow);
  }

  /** 名单命中（守卫用；join active——注销用户即失效）。 */
  isMember(workspaceId: string, userId: string): boolean {
    const r = this.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), eq(users.status, "active")))
      .all()[0];
    return r != null;
  }

  /** 名单（join users 出 username；过滤 active）。 */
  listMembers(workspaceId: string): WsMemberRow[] {
    return this.db
      .select({
        userId: workspaceMembers.userId,
        username: users.username,
        displayName: users.displayName,
        createdAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.status, "active")))
      .all()
      .map((r: any) => ({ userId: r.userId, username: r.username, displayName: r.displayName ?? null, createdAt: r.createdAt }));
  }

  /** 加名单；UNIQUE 冲突（已在）→ AlreadyMember。幂等性由路由层 409 表达。 */
  addMember(workspaceId: string, userId: string): void {
    try {
      this.db.insert(workspaceMembers).values({ workspaceId, userId, createdAt: now() }).run();
    } catch (e: any) {
      if (isUniqueError(e)) throw new AlreadyMember();
      throw e;
    }
  }

  /** 移出名单。幂等（非名单→无操作）。 */
  removeMember(workspaceId: string, userId: string): void {
    this.db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .run();
  }
}
