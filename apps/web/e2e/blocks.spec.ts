import { test, expect } from "@playwright/test";

// f3/ADR-0019 blocks 渲染：thinking 折叠（可展开）、tool_use 图标卡（result 折进卡）。
// stub（e2e-entry「看过程」分支）：thinking→tool_use(read)→tool_result→text 完整序列。
test("blocks：thinking 折叠可展开 + tool_use 卡 + tool_result 折进卡", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toContainText("会话", { timeout: 10_000 });

  await page.locator("textarea").fill("看过程");
  await page.locator("textarea").press("Enter");

  const asst = page.locator(".bubble.assistant").last();

  // thinking：终态折叠一行「已思考 N 字」（流式占位「思考中…」是瞬态——stub 同步发帧不保证可见，race-tolerant 不断言）
  const thinkingRow = asst.getByText(/已思考 \d+ 字/);
  await expect(thinkingRow).toBeVisible({ timeout: 5_000 });
  // 默认折叠：内容不可见；点开可见
  await expect(asst.getByText("先看文件再回答")).toBeHidden();
  await thinkingRow.click();
  await expect(asst.getByText("先看文件再回答")).toBeVisible();

  // tool_use 卡：read→「读取 src/app.ts」摘要（成功 result 折叠在卡内）
  const toolCard = asst.getByText("读取 src/app.ts");
  await expect(toolCard).toBeVisible({ timeout: 5_000 });
  await expect(asst.getByText("export const A = 1;")).toBeHidden(); // 默认折叠

  // text block 落定（done 后）
  await expect(asst).toContainText("看完了，一切正常。", { timeout: 5_000 });
  await expect(page.locator("button.stop")).toHaveCount(0, { timeout: 5_000 });
});
