import { test, expect } from "@playwright/test";

// #21/ADR-0020：会话归档与删除全链（用户视角）。
// e2e 环境 = dev 匿名身份（后端 dev 阀放行为 admin）→ 归档 + 删除菜单都可见。
// 流程：归档 → 主列表消失/归档区可见/composer 禁用 → 恢复 → 重现可发 → 删除 → 彻底消失。

test("归档→只读→恢复→admin 删除全链", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toContainText("会话", { timeout: 10_000 });

  // 会话 A 发一条消息（保证有内容可归档）
  await page.locator("textarea").fill("msgArch");
  await page.locator("textarea").press("Enter");
  await expect(page.locator(".bubble.assistant").last()).toContainText("你好", { timeout: 5_000 });
  await expect(page.locator("button.stop")).toHaveCount(0, { timeout: 5_000 });

  const itemA = page.locator(".conv-list .item").first();
  await expect(itemA).toContainText("会话", { timeout: 3_000 });
  const aTail = (await itemA.textContent())!.replace(/.*会话\s*/, "").trim(); // A 尾码（后续断言 A 消失用）

  // 悬浮菜单：归档（按钮在 .item 的兄弟位——同包裹 div 内）
  await itemA.hover();
  await page.locator(".conv-list button[title='归档']").first().click();

  // 主列表 A 消失（归档乐观下架）。e2e 环境列表通常只有 A → 补位逻辑跳 / 新建 B，
  // 列表长度 -1+1 不变——但 A 的尾码必须消失（修复前误报「归档没生效」的就是这个 -1+1）
  await expect(page.locator(".conv-list .item", { hasText: aTail })).toHaveCount(0, { timeout: 5_000 });

  // 打开归档区：A 可见
  await page.locator("button", { hasText: "归档" }).last().click(); // 侧栏底部折叠入口
  const archivedRow = page.locator(".conv-list .archived-item");
  await expect(archivedRow.first()).toBeVisible({ timeout: 5_000 });

  // 点归档会话名 → 打开只读视图：composer 禁用 + 占位文案
  await archivedRow.first().locator("button").first().click();
  await expect(page.locator("textarea")).toBeDisabled({ timeout: 5_000 });
  await expect(page.locator("textarea")).toHaveAttribute("placeholder", "已归档，恢复后可继续对话");
  // 历史可看
  await expect(page.locator(".bubble.user").first()).toContainText("msgArch", { timeout: 5_000 });

  // 恢复 → 主列表重现 + composer 解禁
  await page.locator("button[title='恢复']").first().click();
  await expect(page.locator(".conv-list .item").first()).toContainText("会话", { timeout: 5_000 });
  await expect(page.locator("textarea")).toBeEnabled({ timeout: 5_000 });

  // admin 删除（悬浮菜单 → 确认）：A 项悬浮删除
  const restoredA = page.locator(".conv-list .item", { hasText: aTail });
  await restoredA.hover();
  await restoredA.locator("~ span button[title='删除（不可恢复）']").click();
  await page.locator("button", { hasText: "确认删除" }).click();
  await expect(restoredA).toHaveCount(0, { timeout: 5_000 });

  // 刷新 → A 彻底消失（归档区也无）
  await page.reload();
  await expect(page.locator("header .conv")).toContainText("会话", { timeout: 10_000 });
  await expect(page.locator(".conv-list .item", { hasText: aTail })).toHaveCount(0, { timeout: 3_000 });
});

test("归档当前会话且还有剩余会话 → 补位跳到剩余第一条（不新建）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toContainText("会话", { timeout: 10_000 });

  // 造两个会话：A（先建）+ B（后建，当前所在）。串行共享 dev-user——列表可能有前序 test 残留，全程相对断言。
  const preCount = await page.locator(".conv-list .item").count(); // 含前序残留 + goto 自动新建的 1 条
  await page.locator("textarea").fill("convA");
  await page.locator("textarea").press("Enter");
  await expect(page.locator("button.stop")).toHaveCount(0, { timeout: 5_000 }); // 等 A 流完
  await page.locator(".conv-list .new").click();
  await expect(page.locator(".conv-list .item")).toHaveCount(preCount + 1, { timeout: 3_000 }); // B 建成

  const bTail = (await page.locator(".conv-list .item").first().textContent())!.replace(/.*会话\s*/, "").trim();

  // 归档当前 B → 补位跳剩余会话；列表长度 -1（不再 -1+1 恒定——修复的核心断言）
  await page.locator(".conv-list .item").first().hover();
  await page.locator(".conv-list button[title='归档']").first().click();
  // header 切走 B = 补位导航已发生（navigate 在 PATCH 返回后——比乐观列表更新晚，须等待式断言）
  await expect
    .poll(async () => (await page.locator("header .conv").textContent()) ?? "", { timeout: 5_000 })
    .not.toContain(bTail);
  await expect(page.locator(".conv-list .item")).toHaveCount(preCount, { timeout: 5_000 });
  await expect(page.locator(".conv-list .item", { hasText: bTail })).toHaveCount(0, { timeout: 3_000 });
  // 补位到的是活跃会话（非归档只读态）
  await expect(page.locator("textarea")).toBeEnabled({ timeout: 5_000 });
});
