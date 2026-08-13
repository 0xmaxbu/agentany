// Drizzle(bun-sqlite) 开库 + 迁移。:memory: 支持（测试）。
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";
import { DATA_DIR } from "../config"; // h6：单一 DATA_DIR 来源（修 db/client 与 config 不一致 bug）

// apps/server/src/db/client.ts → apps/server/drizzle
const MIGRATIONS_FOLDER = new URL("../../drizzle", import.meta.url).pathname;

export function dbFile(): string {
  return `${DATA_DIR}/db.sqlite`;
}

export function openDb(path: string = dbFile()): BunSQLiteDatabase<typeof schema> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path);
  raw.run("PRAGMA foreign_keys = ON"); // h10：开启外键（待 FK 约束补进 schema 后生效）
  return drizzle(raw, { schema });
}

// 启动 / 测试用：开库 + 跑迁移。
export function openDbMigrated(path: string = dbFile()): BunSQLiteDatabase<typeof schema> {
  const db = openDb(path);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}
