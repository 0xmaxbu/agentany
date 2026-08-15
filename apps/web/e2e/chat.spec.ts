import { test, expect } from "@playwright/test";

// 首条流式 turn E2E（#6）：发消息 → token 增量流出（中间 ≠ 终态）→ done 落定。
// backend 的 stub runPi 吐 ["你","好","，","世","界"]（150ms/token）→ "你好，世界"。
test("发消息 → token 增量 → done 落定", async ({ page }) => {
  await page.goto("/");
  // 会话就绪（init 建会话）
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 10_000 }); // #命名：header 名可为主题名

  await page.locator("textarea").fill("hi");
  await page.locator("textarea").press("Enter");

  // assistant 气泡出现 + 第一个 token
  const asst = page.locator(".bubble.assistant").last();
  await expect(asst).toContainText("你", { timeout: 5_000 });
  const mid = (await asst.textContent()) ?? "";

  // 终态全文
  await expect(asst).toContainText("你好，世界", { timeout: 5_000 });
  const full = (await asst.textContent()) ?? "";

  // 增量证据：中间态比终态短（内容在长出来）
  expect(mid.length, `mid="${mid}" 应短于 full="${full}"`).toBeLessThan(full.length);

  // done 落定：流式光标消失 + 停止按钮消失（sending=false）
  await expect(page.locator(".cursor")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator("button.stop")).toHaveCount(0, { timeout: 5_000 });
});
