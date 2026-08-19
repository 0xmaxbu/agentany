#!/usr/bin/env bun
// A/B 金标探针（ADR-0024 验证②）：同一组 prompt，「不注 Soul / 注 Soul」各跑一遍真 pi，
// 并排打印供肉眼对比 + 对注 Soul 组做标记断言（无 emoji / 首句非开场白 / 无客套尾）。
// 手动跑：bun scripts/soul-ab-probe.mjs（需真 provider key；provider 故障期不跑）。
// 退出码：注 Soul 组任一断言挂 → 1（可进未来 CI）；对照组只打印不断言（它就是「看看返回」的基线）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPi } from "../apps/server/src/pi/runPi.ts";
import { CHAT_SYSTEM_PROMPT } from "../apps/server/src/chat/turn.ts";
import { loadSoul } from "../apps/server/src/chat/soul.ts";

const soul = loadSoul();
if (!soul) {
  console.error("仓库根 Soul.md 缺失——先建文件再跑探针。");
  process.exit(1);
}

// 三条固定 prompt，对准 Soul.md 的三类靶：概念解释（过度解释）、短交付（铺垫/客套）、事件通知（总结客套）。
const PROMPTS = [
  "品牌焕新和品牌升级有什么区别？",
  "帮我给客户写一句年会邀请的开场白，要简短。",
  '[系统事件] 工作流 "brand-research"(r-ab-1) 已完成。日志摘要：research(completed)。可用 read_run 查看详情。请简明告知结果。',
];

// 标记断言（只判「注 Soul」组）：
const hasEmoji = (s) => /\p{Extended_Pictographic}/u.test(s);
const opener = (s) => {
  const first = s.split("\n").find((l) => l.trim()) ?? ""; // 首个非空行
  return /^(好的|当然|没问题|当然可以|嗯[，,]?|让我|这(是|个)(很)?好(的)?问题)/.test(first.trim());
};
const closing = (s) => /(希望|若|如果|如有).{0,12}(帮助|需要|用处)|随时(找我|联系|问)/.test(s);

const dir = mkdtempSync(join(tmpdir(), "soul-ab-"));
const once = async (label, i, append) => {
  const r = await runPi({
    prompt: PROMPTS[i],
    sessionId: `soul-ab-${label}-${i}`, // 独立 session：对照组与实验组互不污染历史
    sessionDir: dir,
    cwd: join(dir, label),
    appendSystemPrompt: append,
    timeoutMs: 60_000,
  });
  return r.text.trim();
};

let violations = 0;
for (let i = 0; i < PROMPTS.length; i++) {
  const ctrl = await once("ctrl", i, [CHAT_SYSTEM_PROMPT]); // 对照 = 生产减 Soul
  const trt = await once("trt", i, [CHAT_SYSTEM_PROMPT, soul]); // 实验 = 生产同构
  const marks = [];
  if (hasEmoji(trt)) marks.push("emoji");
  if (opener(trt)) marks.push("开场白");
  if (closing(trt)) marks.push("客套尾");
  if (marks.length) violations += marks.length;
  console.log(`\n${"=".repeat(72)}\n[P${i + 1}] ${PROMPTS[i]}\n${"-".repeat(72)}`);
  console.log(`── 对照（无 Soul，${ctrl.length} 字）──\n${ctrl}`);
  console.log(`── 实验（注 Soul，${trt.length} 字）${marks.length ? `  ✗ 违规: ${marks.join("/")}` : "  ✓ 标记全过"} ──\n${trt}`);
}
rmSync(dir, { recursive: true, force: true });
console.log(`\n${"=".repeat(72)}\n${violations ? `✗ ${violations} 处违规（见上 ✗ 行）` : "✓ 三条 prompt 标记断言全过（语气质感仍需人眼判）"}`);
process.exit(violations ? 1 : 0);
