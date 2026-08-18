// IM 身份绑定存储（spec #49 决策 6 + #55/T5）：imBindings 表 CRUD——绑定 + 幂等解析；
// im_bind_codes 绑定码（T5 自助绑定凭据）——4 位数字短码 + 单次消费（usedAt CAS）+ TTL（expiresAt）兜底。
// 与 auth/store.ts、workspaces/store.ts 同模式：独立小 store，共享 db（tests: openDbMigrated 同实例）。
import { and, eq, gt, isNull } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { randomInt } from "node:crypto";
import { imBindings, imBindCodes, users } from "../db/schema";

export const BIND_CODE_TTL_MS = 10 * 60 * 1000; // ~10min（spec：#bind 时效窗口）

const now = () => new Date().toISOString();

export interface ImBindingRow {
  imUserId: string;
  platform: string;
  userId: string;
  createdAt: string;
}

export class ImStore {
  // <any> 与 WorkflowStore 同口径（bun-sqlite 泛型不协变）；表引用自 schema，drizzle 类型在查时受检。
  constructor(private db: BunSQLiteDatabase<any>) {}

  /** 绑定（幂等 upsert）：(imUserId, platform) 已存在 → 覆盖 userId；否则插入。userId 必须存在（外键由应用层守）。
   *  同用户同平台重复绑另一 imUserId 会被 UNIQUE 拒（返回 null）。返绑定行；userId 不存在 → null。 */
  bind(imUserId: string, platform: string, userId: string): ImBindingRow | null {
    const u = this.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
    if (!u) return null;
    try {
      this.db.insert(imBindings)
        .values({ imUserId, platform, userId, createdAt: now() })
        .onConflictDoUpdate({ target: [imBindings.imUserId, imBindings.platform], set: { userId } })
        .run();
    } catch {
      return null; // (userId, platform) UNIQUE 冲突（同用户已绑另一平台身份）
    }
    const row = this.db.select().from(imBindings)
      .where(and(eq(imBindings.imUserId, imUserId), eq(imBindings.platform, platform)))
      .get();
    return row ? (row as ImBindingRow) : null;
  }

  /** 解绑（幂等）：存在 → true；不存在 → false。 */
  unbind(imUserId: string, platform: string): boolean {
    const r = this.db.delete(imBindings)
      .where(and(eq(imBindings.imUserId, imUserId), eq(imBindings.platform, platform)))
      .run();
    return (r as unknown as { changes: number }).changes > 0;
  }

  /** 解析：IM 身份 → agentany userId（幂等；未绑定 → undefined）。 */
  resolve(imUserId: string, platform: string): { userId: string } | undefined {
    const r = this.db.select({ userId: imBindings.userId }).from(imBindings)
      .where(and(eq(imBindings.imUserId, imUserId), eq(imBindings.platform, platform)))
      .get();
    return r && r.userId ? { userId: r.userId } : undefined;
  }

  /** 反查（spec #55/T1）：agentany 用户 + 平台 → 绑定的 IM 身份（出站路由寻址用——resolve 的反向）。未绑定 → undefined。 */
  reverseResolve(userId: string, platform: string): { imUserId: string } | undefined {
    const r = this.db.select({ imUserId: imBindings.imUserId }).from(imBindings)
      .where(and(eq(imBindings.userId, userId), eq(imBindings.platform, platform)))
      .get();
    return r && r.imUserId ? { imUserId: r.imUserId } : undefined;
  }

  /** 全量（管理端查看）。 */
  list(): ImBindingRow[] {
    return this.db.select().from(imBindings).all().map((r) => r as ImBindingRow);
  }

  // ── 绑定码（spec #55/T5）──

  /** 领码：4 位数字（短码易打——绑定窗口靠 TTL 10min + 单次消费兜底，攻防在短窗口内可枚举/撞库，故不设高熵）。 */
  issueBindCode(userId: string, ttlMs: number = BIND_CODE_TTL_MS): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 10000)).padStart(4, "0"); // 0000–9999
    const createdAt = now();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.insert(imBindCodes).values({ code, userId, createdAt, expiresAt }).run();
    return { code, expiresAt };
  }

  /** 消费（CAS 单次 + TTL）：usedAt IS NULL AND expiresAt > now → 置 usedAt。返回链到账号；已用/过期 → null。 */
  consumeBindCode(code: string): { userId: string } | null {
    const t = now();
    return this.db.update(imBindCodes)
      .set({ usedAt: t })
      .where(and(eq(imBindCodes.code, code), isNull(imBindCodes.usedAt), gt(imBindCodes.expiresAt, t)))
      .returning({ userId: imBindCodes.userId })
      .get() ?? null;
  }
}