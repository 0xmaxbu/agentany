import { test, expect } from "@playwright/test";

// #手风琴：侧栏 ws 手风琴全链。组序（公司置顶）+ 默认只展开公司 + 组内 5 条 + 全部会话弹窗（无限滚动）+ 搜索。
// 分页依赖 >5 条会话——通过 API 直建（UI 建一条要一轮 turn，太慢）。
// #命名：无 title 显示「新会话」——搜索用「新会话」作命中词（API 建的会话均未命名）。

test("手风琴：公司置顶默认展开、组内 5 条、全部会话弹窗、搜索", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 10_000 });

  // API 建 12 条会话（公司 ws）——分页素材；API 建不动前端 store，reload 重载
  for (let i = 0; i < 12; i++) {
    await page.request.post("/conversations", { data: {} });
  }
  await page.reload();
  await expect(page.locator("[data-testid=ws-group-company]")).toBeVisible({ timeout: 10_000 });

  // 公司组默认展开；组内固定 5 条直显 +「全部会话」入口
  await expect(page.locator("[data-testid=ws-group-company] .item")).toHaveCount(5, { timeout: 5_000 });
  await expect(page.locator("[data-testid=ws-all-company]")).toBeVisible();

  // 全部会话弹窗：打开 → 自动分页拉取（不足一屏自动续拉到全量 13；「已全部加载」收尾）。
  // 无限滚动的验证点 = 滚动触底继续拉（此处总量小被未溢出续拉覆盖——拉完即 exhausted）。
  await page.locator("[data-testid=ws-all-company]").click();
  const scroll = page.locator("[data-testid=browse-scroll]");
  await expect(scroll).toBeVisible({ timeout: 5_000 });
  await expect
    .poll(async () => scroll.locator(".item").count(), { timeout: 5_000 })
    .toBeGreaterThanOrEqual(13); // 本轮 ≥13（goto 1 + API 12 + 可能的串行残留）
  await expect(scroll).toContainText("已全部加载", { timeout: 5_000 });
  await expect(scroll.getByText(/^(刚刚|\d+ 分钟前)$/).first()).toBeVisible(); // 最后活跃时间显示（API 刚建）
  // 弹窗内点会话 → 关弹窗进会话
  await scroll.locator(".item").first().click();
  await expect(page.locator("[data-testid=browse-backdrop]")).toBeHidden({ timeout: 5_000 });
  await expect(page.locator("header .conv")).toBeVisible();

  // 折叠公司组 → 会话项消失；再展开恢复
  await page.locator("[data-testid=ws-toggle-company]").click();
  await expect(page.locator("[data-testid=ws-group-company] .item")).toHaveCount(0);
  await page.locator("[data-testid=ws-toggle-company]").click();
  await expect(page.locator("[data-testid=ws-group-company] .item").first()).toBeVisible({ timeout: 5_000 });

  // 组头 + 按钮：在公司 ws 建会话（hover 显 +）
  await page.locator("[data-testid=ws-toggle-company]").hover();
  await page.locator("[data-testid=ws-new-company]").click();
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 5_000 }); // 新会话打开

  // 搜索：命中所有「新会话」（API 建的均未命名——全量兜底 > 5 条，验证搜索绕过分页）
  await page.locator("[data-testid=conv-search]").fill("新会话");
  await expect(page.locator(".conv-list .item").first()).toBeVisible({ timeout: 5_000 });
  const searchCount = await page.locator(".conv-list .item").count();
  expect(searchCount).toBeGreaterThan(5); // 分页态只有 5——搜索态全量
  // 无匹配空态
  await page.locator("[data-testid=conv-search]").fill("no-such-conv-xyz");
  await expect(page.locator("text=无匹配会话")).toBeVisible({ timeout: 5_000 });
  // 清空 → 回分页分组态
  await page.locator("[data-testid=conv-search]").fill("");
  await expect(page.locator("[data-testid=ws-group-company]")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("[data-testid=ws-group-company] .item").first()).toBeVisible();
});

test("手风琴：ws 归档 switch → 侧栏组消失 → 恢复回来", async ({ page }) => {
  await page.goto("/admin/workspaces");
  await expect(page.locator("h1")).toHaveText("Workspace 管理", { timeout: 10_000 });

  // 建一个专属 ws（slug 自动）
  const wsName = `acc-${Date.now().toString(36).slice(-6)}`;
  await page.locator("[data-testid=open-create-ws]").click();
  await page.locator("[data-testid=new-ws-name]").fill(wsName);
  await page.locator("[data-testid=create-ws]").click();
  await expect(page.locator("[data-testid=ws-table] tbody tr", { hasText: wsName })).toBeVisible({ timeout: 5_000 });

  // 公司 ws 无 switch
  await expect(page.locator("[data-testid=ws-archive-switch-company]")).toHaveCount(0);

  // 回 chat：新 ws 组可见（默认收起）
  await page.locator("[data-testid=user-footer]").hover();
  await page.locator("button", { hasText: "管理" }).click(); // 去 admin 先
  await page.locator("button", { hasText: "返回对话" }).click();
  const wsRow = page.locator(`[data-testid^=ws-group-]`, { hasText: wsName });
  await expect(wsRow).toBeVisible({ timeout: 5_000 });

  // 管理页拨 switch 归档 → chat 侧栏组消失（「管理」入口指 /admin/users——显式跳 workspace 页）
  await page.goto("/admin/workspaces");
  await expect(page.locator("h1")).toHaveText("Workspace 管理", { timeout: 5_000 });
  const rowLive = page.locator("[data-testid=ws-table] tbody tr", { hasText: wsName });
  await rowLive.locator("input[type=checkbox]").uncheck(); // 归档
  await expect(page.locator("[data-testid=ws-table] tbody tr", { hasText: "已归档" }).and(page.locator(`tr:has-text("${wsName}")`))).toBeVisible({ timeout: 5_000 });
  await page.locator("button", { hasText: "返回对话" }).click();
  await expect(page.locator(`[data-testid^=ws-group-]`, { hasText: wsName })).toHaveCount(0, { timeout: 5_000 });

  // 恢复 → 组回来
  await page.goto("/admin/workspaces");
  const rowArchived = page.locator("[data-testid=ws-table] tbody tr", { hasText: wsName }); // 归档后行仍可见（灰显）
  await rowArchived.locator("input[type=checkbox]").check(); // 恢复
  await page.locator("button", { hasText: "返回对话" }).click();
  await expect(page.locator(`[data-testid^=ws-group-]`, { hasText: wsName })).toBeVisible({ timeout: 5_000 });
});
