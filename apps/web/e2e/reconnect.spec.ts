import { test, expect } from "@playwright/test";

// T5（#54）：断流自动重连 + 三快照对账（runStreamLoop 有界退避 + reconcile）。
// route.abort 掐断首个 SSE 请求 → runStreamLoop 退避重连 → 快照对账幂等合并：
// 消息不丢、不重复显卡/消息、断流不落 error 气泡。
test("断流 → 自动重连 → 消息不丢不乱（对账幂等）", async ({ page }) => {
  let dropped = false;
  await page.route("**/conversations/*/stream", async (route) => {
    if (!dropped) {
      dropped = true;
      await route.abort(); // 首个 SSE 长连被断（net::ERR_FAILED → fetch 拒绝 → 走重连退避）
      return;
    }
    await route.continue(); // 重连后的流正常
  });

  await page.goto("/");
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 10_000 }); // #命名：header 名可为主题名

  await page.locator("textarea").fill("hi");
  await page.locator("textarea").press("Enter");

  // 断流期间的消息/回复经重连 + 对账后仍正常出现（增量直至终态）
  const asst = page.locator(".bubble.assistant").last();
  await expect(asst).toContainText("你好，世界", { timeout: 10_000 });

  // 对账幂等：回复气泡只出现一次（无重复显卡/消息）
  await expect(page.locator(".bubble.assistant").filter({ hasText: "你好，世界" })).toHaveCount(1);

  // 断流被吞进重连循环（不落 errMsg error 气泡）
  await expect(page.locator(".bubble.assistant").filter({ hasText: /fail|error|无法/ })).toHaveCount(0);
});