import { test, expect } from "@playwright/test";

// #命名：新建会话显示「新会话」；首轮对话完成 → LLM 提取主题 → 侧栏条目实时换名（title 帧）。
// e2e 后端 stub 对「提取主题」调用回用户消息前 16 字（≥8 字下限）。

test("首轮对话后侧栏条目自动换名（新会话 → 主题）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 10_000 });

  // 新建的会话（当前会话）在侧栏顶部显示「新会话」
  const item = page.locator(".conv-list .item").first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  await expect(item).toContainText("新会话");

  // 发一条消息 → turn 完成 → title 帧推回 → 侧栏同一条目换为主题名（不刷新页面）
  const msg = "这段对话用来测试自动命名主题功能";
  await page.locator("textarea").fill(msg);
  await page.locator("textarea").press("Enter");
  await expect(page.locator(".bubble.assistant").last()).toContainText("你好", { timeout: 5_000 });
  await expect(page.locator("button.stop")).toHaveCount(0, { timeout: 5_000 });
  await expect(item).toContainText(msg.slice(0, 16), { timeout: 5_000 });
  await expect(item).not.toContainText("新会话");
});
