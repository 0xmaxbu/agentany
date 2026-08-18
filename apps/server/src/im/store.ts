// IM 身份绑定存储（spec #49 决策 6）：imBindings 表 CRUD——管理端静态绑定 + 幂等解析。
// 与 auth/store.ts、workspaces/store.ts 同模式：独立小 store，共享 db（tests: openDbMigrated 同实例）。
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { imBindings, users } from "../db/schema";

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

  /** 全量（管理端查看）。 */
  list(): ImBindingRow[] {
    return this.db.select().from(imBindings).all().map((r) => r as ImBindingRow);
  }
}