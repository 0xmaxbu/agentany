import { test, expect } from "@playwright/test";

// #19 E2E 全链（e2e-entry scripted stub 驱动【真桥接 + 真事件】）：
// 发「跑合成三步」→ stub 调 start_workflow → run 卡 + step 进度 → run_suspended → 自动 turn → ask_user 卡
// → 点 accept → 判答 resume → run_completed → 自动总结 → 刷新恢复（ask 已答 + 历史）。
// 注：runs 是 SSE 瞬时态（无 GET /runs），刷新不恢复 run 卡——断 ask 卡（GET /hitl 持久）+ 消息历史。
test("工作流全链：start → suspend → ask → resume → completed + 刷新恢复", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toContainText("会话", { timeout: 10_000 });

  await page.locator("textarea").fill("跑合成三步");
  await page.locator("textarea").press("Enter");

  // run 卡出现（run_started）
  const runCard = page.locator(".run").filter({ hasText: "synthetic-3step" });
  await expect(runCard).toBeVisible({ timeout: 5_000 });

  // run 进入 suspended（run_suspended）+ ask 卡出现（suspend 事件 turn → ask_user）
  await expect(runCard).toContainText("suspended", { timeout: 8_000 });
  // #19 step 进度：s1 已完成、review 挂起（step_started/completed 经持久流 → run.steps 渲染）
  await expect(runCard).toContainText("s1", { timeout: 5_000 });
  await expect(runCard).toContainText("review", { timeout: 5_000 });
  const askCard = page.locator(".hitl").filter({ hasText: "选哪个？" });
  await expect(askCard).toBeVisible({ timeout: 8_000 });

  // 点 accept → stub 判答 resume → synthetic 续跑至 completed
  await askCard.locator("button", { hasText: "accept" }).click();
  await expect(runCard).toContainText("completed", { timeout: 8_000 });
  // #19 step 进度：s2 终结步出现（resume 后 review→s2）
  await expect(runCard).toContainText("s2", { timeout: 5_000 });

  // 总结气泡（completed 事件 turn）
  await expect(page.locator(".bubble.assistant").last()).toContainText("总结", { timeout: 8_000 });

  // 刷新恢复：ask 卡（已答，GET /hitl 持久）+ 消息历史
  await page.reload();
  await expect(askCard).toContainText("已回答", { timeout: 5_000 });
  await expect(page.locator(".bubble.user").first()).toContainText("跑合成三步", { timeout: 5_000 });
});
