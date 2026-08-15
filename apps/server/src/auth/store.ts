// 用户 + opaque token 数据访问（ADR-0014 真 auth）。照搬 WorkflowStore 写法：引擎外唯一耦合 db 的本域文件。
// 密码 = argon2id（Bun.password 内置零依赖）；token = 落库 sha256（非明文），注销/改密/重置=删行。
import { and, eq, ne } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { authTokens, users } from "../db/schema";

const now = (): string => new Date().toISOString();
const newUserId = (): string => "u_" + globalThis.crypto.randomUUID();
const bytes2hex = (b: Uint8Array): string => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
// 32 随机字节 → 256 bit；明文仅返回给客户端一次，库内存 sha256。
const newToken = (): string => "at_" + bytes2hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const hashPassword = (pw: string): Promise<string> => Bun.password.hash(pw); // argon2id 默认
const verifyPassword = (pw: string, hash: string): Promise<boolean> => Bun.password.verify(pw, hash);

// 时序拉平（防登录用户名枚举侧信道）：hash 为 null（用户不存在/停用）时仍跑一次 argon2 verify，恒返回 false。
let DUMMY_HASH: string | null = null;
export async function timingSafeVerify(password: string, hash: string | null): Promise<boolean> {
  const h = hash ?? (DUMMY_HASH ??= await hashPassword("timing-equalizer"));
  const valid = await verifyPassword(password, h);
  return hash ? valid : false; // 无用户/已停用：跑满耗时但恒 false
}

export const ROLE = { admin: "admin", member: "member" } as const; // 角色字面量唯一源（判 === 统一引此，不落字面量）
export type UserRole = keyof typeof ROLE;
export const USER_STATUS = { active: "active", deactivated: "deactivated" } as const;
export type UserStatus = keyof typeof USER_STATUS;

export interface UserRow {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export class UsernameTaken extends Error {
  constructor(username: string) {
    super(`username taken: ${username}`);
    this.name = "UsernameTaken";
  }
}
export class BadPassword extends Error {
  constructor() {
    super("wrong current password");
    this.name = "BadPassword";
  }
}

const toUserRow = (r: any): UserRow => ({
  id: r.id,
  username: r.username,
  displayName: r.displayName ?? null,
  role: r.role,
  status: r.status,
  createdAt: r.createdAt,
});

export class UserStore {
  constructor(private db: BunSQLiteDatabase<any>) {}

  /** 开通：插 users；重名（UNIQUE 约束）抛 UsernameTaken。 */
  async createUser(p: { username: string; password: string; displayName?: string; role?: UserRole }): Promise<UserRow> {
    const row = {
      id: newUserId(),
      username: p.username,
      passwordHash: await hashPassword(p.password),
      displayName: p.displayName ?? null,
      role: p.role ?? ("member" as UserRole),
      status: "active" as UserStatus,
      createdAt: now(),
    };
    try {
      this.db.insert(users).values(row).run();
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      const code = String(e?.code ?? "");
      if (/UNIQUE/i.test(msg) || code.includes("CONSTRAINT")) throw new UsernameTaken(p.username);
      throw e;
    }
    return toUserRow(row);
  }

  getUserById(id: string): UserRow | null {
    const r = this.db.select().from(users).where(eq(users.id, id)).all()[0];
    return r ? toUserRow(r) : null;
  }

  /** 登录用：含 passwordHash（仅鉴权用，勿外泄）。 */
  getUserByUsername(username: string): (UserRow & { passwordHash: string }) | null {
    const r = this.db.select().from(users).where(eq(users.username, username)).all()[0];
    return r ? { ...toUserRow(r), passwordHash: r.passwordHash } : null;
  }

  listUsers(): UserRow[] {
    return this.db.select().from(users).orderBy(users.createdAt).all().map(toUserRow);
  }

  /** 改密（本人）：校验旧密码（错抛 BadPassword）→ 设新 hash。用户不存在 → false。token 吊销由路由编排。 */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
    const u = this.db.select().from(users).where(eq(users.id, userId)).all()[0];
    if (!u) return false;
    if (!(await verifyPassword(currentPassword, u.passwordHash))) throw new BadPassword();
    await this.setPassword(userId, newPassword);
    return true;
  }

  /** admin 重置：不需旧密码 → 设新 hash。用户不存在 → false。token 吊销由路由编排。 */
  async resetPassword(userId: string, newPassword: string): Promise<boolean> {
    const u = this.db.select().from(users).where(eq(users.id, userId)).all()[0];
    if (!u) return false;
    await this.setPassword(userId, newPassword);
    return true;
  }

  /** 注销：status='deactivated' + 删该用户全部 token（一事务级联，路由再断 SSE）。不存在 → false。 */
  deactivateUser(userId: string): boolean {
    const r = this.db.update(users).set({ status: "deactivated" }).where(eq(users.id, userId)).run();
    const changed = (r as any).changes ?? 0;
    if (changed > 0) this.revokeUserTokens(userId);
    return changed > 0;
  }

  /** f4：恢复（deactivate 逆）。幂等（active 再 activate no-op 仍 true）；token 已在停用时吊销——恢复后重新登录。 */
  activateUser(userId: string): boolean {
    const r = this.db.update(users).set({ status: "active" }).where(eq(users.id, userId)).run();
    return ((r as any).changes ?? 0) > 0;
  }

  /** 签发：生成明文 token，落 sha256；返回明文（仅给客户端一次）。 */
  async issueToken(userId: string): Promise<string> {
    const token = newToken();
    this.db.insert(authTokens).values({ tokenHash: sha256(token), userId, createdAt: now() }).run();
    return token;
  }

  /** 校验 token → 活跃用户；停用/不存在/已吊销 → null（innerJoin + status='active'）。 */
  resolveToken(token: string): UserRow | null {
    const rows = this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        createdAt: users.createdAt,
      })
      .from(authTokens)
      .innerJoin(users, eq(authTokens.userId, users.id))
      .where(and(eq(authTokens.tokenHash, sha256(token)), eq(users.status, "active")))
      .all();
    return rows[0] ? toUserRow(rows[0]) : null;
  }

  revokeToken(token: string): void {
    this.db.delete(authTokens).where(eq(authTokens.tokenHash, sha256(token))).run();
  }

  /** 吊销某用户全部 token（deactivate / reset-password）。 */
  revokeUserTokens(userId: string): number {
    const r = this.db.delete(authTokens).where(eq(authTokens.userId, userId)).run();
    return (r as any).changes ?? 0;
  }

  /** 吊销某用户除当前会话外的全部 token（change-password：留当前会话，自愈靠前端 SSE 重连）。 */
  revokeUserTokensExcept(userId: string, keepToken: string): number {
    const r = this.db
      .delete(authTokens)
      .where(and(eq(authTokens.userId, userId), ne(authTokens.tokenHash, sha256(keepToken))))
      .run();
    return (r as any).changes ?? 0;
  }

  /** bootstrap admin 幂等 upsert（env 是真相源）：存在→重置密码+确保 admin/active；不存在→建 admin。 */
  async upsertBootstrapAdmin(p: { username: string; password: string }): Promise<UserRow> {
    const hash = await hashPassword(p.password);
    const existing = this.getUserByUsername(p.username);
    if (existing) {
      this.db.update(users).set({ passwordHash: hash, role: "admin", status: "active" }).where(eq(users.id, existing.id)).run();
      return this.getUserById(existing.id)!;
    }
    const row = {
      id: newUserId(),
      username: p.username,
      passwordHash: hash,
      displayName: null,
      role: "admin" as UserRole,
      status: "active" as UserStatus,
      createdAt: now(),
    };
    this.db.insert(users).values(row).run();
    return toUserRow(row);
  }

  private async setPassword(userId: string, pw: string): Promise<void> {
    const hash = await hashPassword(pw);
    this.db.update(users).set({ passwordHash: hash }).where(eq(users.id, userId)).run();
  }
}
