/**
 * Tavily proxy 网关核心逻辑（纯 Node，无 pi/typebox 依赖，可独立单测）
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const BASE_URL = "https://tavily.sharyuke.com/api/proxy";
export const ENV_KEY = "TAVILY_PROXY_API_KEY";
const TIMEOUT_MS = 30000;

export function loadApiKey(): string {
  if (process.env[ENV_KEY]) return process.env[ENV_KEY]!;
  // 从 cwd 向上找 .env
  let dir = process.cwd();
  for (;;) {
    const envPath = path.join(dir, ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      const m = content.match(new RegExp(`^${ENV_KEY}\\s*=\\s*(.+)$`, "m"));
      if (m) return m[1].trim();
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

export interface TavilyResult {
  title?: string;
  name?: string;
  url?: string;
  content?: string;
  text?: string;
  [k: string]: unknown;
}

/** 调用网关并解包 { code, data:{ ok, data:<Tavily原文> } } */
export async function proxyCall(endpoint: string, body: unknown, key: string): Promise<unknown> {
  let res: Response;
  let rawText: string;
  try {
    res = await fetch(`${BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    rawText = await res.text();
  } catch (err) {
    throw new Error(`Tavily 网关请求失败（网络/超时）: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`Tavily 网关 HTTP ${res.status}: ${rawText.slice(0, 300)}`);
  }
  let json: { code?: number; data?: { ok?: boolean; data?: unknown; message?: string } };
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error(`Tavily 网关返回非 JSON: ${rawText.slice(0, 200)}`);
  }
  if (!json.data || json.data.ok !== true || json.data.data === undefined) {
    const raw = JSON.stringify(json);
    const quotaHit = res.status === 429 || json.code === 42901 || /quota|credit|insufficient|配额|余额|耗尽|42901/i.test(raw);
    if (quotaHit) {
      throw new Error(
        `Tavily 网关配额不足（code ${json.code ?? res.status}）：请等待配额恢复、更换 .env 的 TAVILY_PROXY_API_KEY，或在网关升级套餐。`
      );
    }
    throw new Error(`Tavily 网关返回异常: ${raw.slice(0, 300)}`);
  }
  return json.data.data;
}

export function resultsToText(label: string, results: TavilyResult[] | undefined): string {
  if (!results || results.length === 0) return `${label}: 无结果`;
  const lines = results.map((r, i) => {
    const title = r.title || r.name || "(无标题)";
    const url = r.url || "";
    const content = (r.content || r.text || "").toString().slice(0, 500);
    return `${i + 1}. ${title}\n   URL: ${url}\n   ${content.replace(/\s+/g, " ").trim()}`;
  });
  return `${label}: ${results.length} 条结果\n\n${lines.join("\n\n")}`;
}
