import { test, expect } from "@playwright/test";

// #7：markdown 渲染（真 DOM）+ Stop 中断。
// stub（e2e-entry）吐 markdown tokens → "<h1>你好，世界</h1><p><strong>测试</strong></p><p><code>code</code></p>"。

test("assistant 消息按 markdown 渲染（h1 / strong / code 真 DOM）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toContainText("会话", { timeout: 10_000 });

  await page.locator("textarea").fill("md");
  await page.locator("textarea").press("Enter");

  const asst = page.locator(".bubble.assistant").last();
  // markdown 真 DOM：标题、粗体、行内代码
  await expect(asst.locator("h1")).toContainText("你好，世界", { timeout: 5_000 });
  await expect(asst.locator("strong")).toContainText("测试", { timeout: 5_000 });
  await expect(asst.locator("code")).toContainText("code", { timeout: 5_000 });
  // done 落定
  await expect(page.locator(".cursor")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator("button.stop")).toHaveCount(0, { timeout: 5_000 });
});

test("Stop 中断流 → 消息标 aborted、无残留 token", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toContainText("会话", { timeout: 10_000 });

  await page.locator("textarea").fill("stop me");
  await page.locator("textarea").press("Enter");

  // 流式中出现"停止"按钮 → 立即点
  const stopBtn = page.locator("button.stop");
  await expect(stopBtn).toBeVisible({ timeout: 3_000 });
  await stopBtn.click();

  // 发送态结束（停止按钮消失）
  await expect(stopBtn).toHaveCount(0, { timeout: 5_000 });
  // 末位 assistant 气泡标 aborted
  const asst = page.locator(".bubble.assistant").last();
  await expect(asst).toHaveClass(/aborted/, { timeout: 5_000 });
  await expect(page.locator(".cursor")).toHaveCount(0, { timeout: 5_000 });
});
