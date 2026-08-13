// tavily-core 纯逻辑单测（免网络、免 key、免 LLM）
import assert from "node:assert";
import { loadApiKey, resultsToText, ENV_KEY } from "../extensions/tavily-core.ts";

// 1. loadApiKey 从 .env 读到非空 key
const key = loadApiKey();
assert.ok(key, "loadApiKey 应返回非空 key（.env 或 env var）");
console.log(`PASS 1: loadApiKey 返回 key，长度 ${key.length}`);

// 2. env var 优先于 .env
process.env[ENV_KEY] = "thb-env-test";
assert.equal(loadApiKey(), "thb-env-test");
console.log("PASS 2: env var 优先于 .env");
delete process.env[ENV_KEY];

// 3. resultsToText 格式化（标题/URL/内容清洗/条数）
const text = resultsToText("测试", [
  { title: "品牌A", url: "https://a.com", content: "  一些  内容\n换行  " },
  { title: "品牌B" },
]);
assert.ok(text.includes("品牌A"), "含标题");
assert.ok(text.includes("https://a.com"), "含 URL");
assert.ok(text.includes("一些 内容"), "内容空白压缩");
assert.ok(text.includes("2 条结果"), "含条数");
console.log("PASS 3: resultsToText 格式化正确");

// 4. 空结果
assert.equal(resultsToText("测试", undefined), "测试: 无结果");
assert.equal(resultsToText("测试", []), "测试: 无结果");
console.log("PASS 4: 空结果处理");

console.log("\n--- tavily-core 单测全部通过 ---");
