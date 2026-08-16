// cron 表达式口径（#25/ADR-0021）：cron-parser 为唯一解析依赖；频率下限（相邻火点 ≥1h）防 LLM 错解频率。
import { CronExpressionParser } from "cron-parser";

export const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1h

export class InvalidCron extends Error {
  constructor(expr: string) { super(`invalid cron: ${expr}`); this.name = "InvalidCron"; }
}
export class TooFrequent extends Error {
  constructor(expr: string) { super(`cron too frequent (<1h between fires): ${expr}`); this.name = "TooFrequent"; }
}

/** 解析 5 段 cron（from 起算）。非法抛 InvalidCron。 */
function parseCron(expr: string, from: Date) {
  try {
    return CronExpressionParser.parse(expr, { currentDate: from });
  } catch {
    throw new InvalidCron(expr);
  }
}

/**
 * 建任务校验：cron 合法 + 相邻火点间隔 >= 1h（"0 每4小时写法" 合法；每小时与每30分钟写法拒）。
 * 返回从 from 起的首个未来火点 ISO（createTask 的首个 nextFireAt）。
 */
export function validateCronAndFirstFire(expr: string, from: Date = new Date()): string {
  const it = parseCron(expr, from);
  const a = it.next().toDate();
  const b = it.next().toDate();
  if (b.getTime() - a.getTime() < MIN_INTERVAL_MS) throw new TooFrequent(expr);
  return a.toISOString();
}

/** 下一火点（from 之后）。调度循环 markFired 用。 */
export function nextFireAfter(expr: string, from: Date): string {
  try {
    return CronExpressionParser.parse(expr, { currentDate: from }).next().toDate().toISOString();
  } catch {
    throw new InvalidCron(expr);
  }
}
