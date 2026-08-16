// #34/M5-1 反馈面 E2E：消息级 👍/👎 + 备注 + 回显；run 级批注 + 评分 + 回显。
// 消息级素材：stub turn 回「你好，世界」→ done 后气泡尾出反馈控件。
// run 级素材：发「跑合成三步」→ run 卡内批注表单。
import { test, expect } from "@playwright/test";

test("消息级：👍 点击 → 高亮；展开备注 → 提交回显", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 10_000 });

  await page.locator("textarea").fill("你好");
  await page.locator("textarea").press("Enter");
  const bubble = page.locator(".bubble.assistant").last();
  await expect(bubble).toContainText("你好，世界", { timeout: 10_000 });

  // 控件在干净结束后出现
  const fb = page.locator("[data-testid=msg-feedback]").last();
  await expect(fb).toBeVisible({ timeout: 5_000 });

  // 点 👍 → 高亮（fill 变体 + 主色）
  await fb.locator("[data-testid=thumb-up]").click();
  await expect(fb.locator("[data-testid=thumb-up]")).toHaveClass(/text-primary/, { timeout: 5_000 });

  // 刷新回显（GET 回来仍高亮）
  await page.reload();
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 10_000 });
  const fb2 = page.locator("[data-testid=msg-feedback]").last();
  await expect(fb2.locator("[data-testid=thumb-up]")).toHaveClass(/text-primary/, { timeout: 5_000 });

  // 展开备注 → 提交 → 文本回显
  await fb2.locator("[data-testid=feedback-note-toggle]").click();
  await fb2.locator("[data-testid=feedback-note-input]").fill("回答很准");
  await fb2.locator("[data-testid=feedback-note-submit]").click();
  await expect(fb2).toContainText("回答很准", { timeout: 5_000 });
});

test("run 级：批注 + 评分 → 提交回显", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 10_000 });

  await page.locator("textarea").fill("跑合成三步");
  await page.locator("textarea").press("Enter");
  const runCard = page.locator(".run").filter({ hasText: "synthetic-3step" });
  await expect(runCard).toBeVisible({ timeout: 8_000 });

  await runCard.locator("[data-testid=run-feedback-open]").click();
  await runCard.locator("[data-testid=run-feedback-text]").fill("这次执行很顺");
  await runCard.locator("[data-testid=run-feedback-rating]").selectOption("4");
  await runCard.locator("[data-testid=run-feedback-submit]").click();
  await expect(runCard.locator("[data-testid=run-feedback]")).toContainText("这次执行很顺 · 4/5", { timeout: 5_000 });
});
