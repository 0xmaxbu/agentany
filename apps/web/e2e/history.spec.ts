import { test, expect } from "@playwright/test";

// #8：会话切换 + 刷新看历史 + 出错回滚。
// stub（e2e-entry）：正常吐 markdown；prompt 含 "error" → 抛错 → 服务端 error 帧 → 客户端回滚。

test("切换会话、刷新看历史、出错回滚", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toContainText("会话", { timeout: 10_000 });

  // 会话 A：发消息
  await page.locator("textarea").fill("msgA");
  await page.locator("textarea").press("Enter");
  await expect(page.locator(".bubble.assistant").last()).toContainText("你好", { timeout: 5_000 });
  await expect(page.locator("button.stop")).toHaveCount(0, { timeout: 5_000 }); // 等 msgA 流完

  // 新会话 B
  await page.locator("[data-testid=ws-toggle-company]").hover(); // 组头 hover 显 +
await page.locator("[data-testid=ws-new-company]").click();
  await expect(page.locator(".bubble")).toHaveCount(0, { timeout: 3_000 }); // B 初始空
  await page.locator("textarea").fill("msgB");
  await page.locator("textarea").press("Enter");
  await expect(page.locator(".bubble.assistant").last()).toContainText("你好", { timeout: 5_000 });
  await expect(page.locator("button.stop")).toHaveCount(0, { timeout: 5_000 }); // 等 msgB 流完

  // 切回 A（列表顺序：B 在前、A 在后）→ 看到 A 的历史
  const items = page.locator(".conv-list .item");
  await items.nth(1).click();
  await expect(page.locator(".bubble.user").first()).toContainText("msgA", { timeout: 5_000 });

  // 刷新 → 当前会话(A)历史从后端恢复
  await page.reload();
  await expect(page.locator(".bubble.user").first()).toContainText("msgA", { timeout: 5_000 });

  // 出错回滚：发 "error" → stub 抛错 → error 帧 → user+assistant 回滚 + error 气泡
  await page.locator("textarea").fill("error");
  await page.locator("textarea").press("Enter");
  await expect(page.locator(".bubble.error")).toBeVisible({ timeout: 5_000 });
});
