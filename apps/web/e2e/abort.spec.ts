import { test, expect } from "@playwright/test";

// #19 abort E2E：跑工作流期间点 Stop → 发送态结束 + UI 不卡死（可继续发消息）。
// 注：workflow turn 快（stub 调 /run/start 即返），Stop 按钮可能转瞬即逝——race-tolerant（可见才点）。
// run 级停止（stopConversationRuns）的确定性由后端单测覆盖（store/registry/route）；chat turn Stop 由 markdown.spec 覆盖。
test("abort：跑工作流后 Stop → 发送态结束、UI 可继续发消息", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toContainText("会话", { timeout: 10_000 });

  await page.locator("textarea").fill("跑合成三步");
  await page.locator("textarea").press("Enter");

  const runCard = page.locator(".run").filter({ hasText: "synthetic-3step" });
  await expect(runCard).toBeVisible({ timeout: 5_000 });

  // 尝试点 Stop（若可见；workflow turn 快可能已结束——race-tolerant：失败也忽略）
  const stopBtn = page.locator("button.stop");
  try { await stopBtn.click({ timeout: 500 }); } catch { /* 按钮已消失，turn 自然结束 */ }
  await expect(stopBtn).toHaveCount(0, { timeout: 8_000 }); // 发送态结束（点 Stop 或 turn 自然结束）

  // UI 不卡死：能继续发消息（POST 即落用户气泡）
  await page.locator("textarea").fill("你好");
  await page.locator("textarea").press("Enter");
  await expect(page.locator(".bubble.user").last()).toContainText("你好", { timeout: 5_000 });
});
