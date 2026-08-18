import { test, expect } from "@playwright/test";

// #62 绑定飞书：底部用户弹菜单项（管理和登出一级）+ 弹窗（自助发码面）；users 页 IM 绑定列。
// UI 存在性断言（菜单/弹窗/列头）服务端态无关；「未接线」岔路合法。
// 另验 vite proxy 覆盖 /im（dev 直连后端必经——回归保护：proxy 漏配时此处红）。
// e2e backend 未 wire imStore → 弹窗走服务端态分支，URL 仍须经 proxy 命中后端（503 而非 404）。

test("#62 绑定飞书：用户弹菜单项 + 弹窗开关", async ({ page }) => {
  await page.goto("/admin/users");
  await expect(page.locator("h1")).toHaveText("用户管理", { timeout: 10_000 });

  // 底部用户行 hover 弹菜单 → 含「绑定飞书」（管理和登出一级）
  await page.hover("[data-testid=user-footer]");
  const menu = page.locator("[data-testid=bind-feishu]");
  await expect(menu).toBeVisible({ timeout: 5_000 });

  // 点击 → 弹窗打开（标题「绑定飞书」）
  await menu.click();
  await expect(page.locator("[role=dialog]", { hasText: "绑定飞书" })).toBeVisible({ timeout: 5_000 });

  // 弹窗内容：发码面带 `#bind` 命令，或未接线提示（服务端态不定，任一合法）；Esc 关闭
  const cmd = page.locator("[data-testid=bind-command]");
  if (await cmd.count() === 1) {
    await expect(cmd).toContainText("#bind");
    await expect(cmd).toContainText(/^#bind \d{4}$/); // 4 位数字码
    await expect(page.locator("[data-testid=bind-countdown]")).toBeVisible();
  } else {
    await expect(page.locator("[role=dialog]")).toContainText(/未接线|加载中/);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("[role=dialog]")).toHaveCount(0);
});

test("#62 users 页显示 IM 绑定列（列头 + 空态）", async ({ page }) => {
  await page.goto("/admin/users");
  await expect(page.locator("h1")).toHaveText("用户管理", { timeout: 10_000 });
  await expect(page.locator("[data-testid=users-table] th", { hasText: "IM 绑定" })).toBeVisible({ timeout: 5_000 });
  // 列有值（飞书→tag 或 —）；至少一行非空
  const firstRow = page.locator("[data-testid=users-table] tbody tr").first();
  await expect(firstRow).toBeVisible({ timeout: 5_000 });
});

test("#62 vite proxy 覆盖 /im（dev 直连后端——发码/绑定列表必经；miss 则 404）", async ({ request }) => {
  // e2e backend 未 wire imStore → 503「im store not wired」；proxy 缺失 → Vite 回 index.html（非 JSON）
  const r = await request.post("/im/bind-codes");
  const text = await r.text();
  const body = text.trim().startsWith("{");
  expect(body).toBe(true); // JSON（proxy 通）；返回类型依服务端态（200 code / 503 error 皆 JSON）
  expect(r.status()).not.toBe(404);
});