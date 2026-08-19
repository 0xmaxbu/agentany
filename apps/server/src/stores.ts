// createStores（ADR-0030 决策 5）：四域 store 的**唯一装配点**——boot（index.ts）与 test/deps.ts 共用，
// 装配知识单点不漂。同一 db 喂四 store（共享单调时钟 now / J / P，db-utils）。
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { RunsStore } from "./runs/store";
import { ChatStore } from "./chat/store";
import { HitlStore } from "./hitl/store";
import { FeedbackStore } from "./feedback/store";

export interface Stores {
  runs: RunsStore;
  chat: ChatStore;
  hitl: HitlStore;
  feedback: FeedbackStore;
}

export const createStores = (db: BunSQLiteDatabase<any>): Stores => ({
  runs: new RunsStore(db),
  chat: new ChatStore(db),
  hitl: new HitlStore(db),
  feedback: new FeedbackStore(db),
});