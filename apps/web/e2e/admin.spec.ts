import { test, expect } from "@playwright/test";

// f4：管理页全链（admin 视角）。表格 + 搜索 + 弹窗（新建/编辑）；Sidebar admin 态 + 底部用户行（Kimi 式）。
// 三段：① 用户管理（建→停用→恢复→搜索）② workspace 管理（建→编辑弹窗改名→搜索）③ member 无权限页。
// dev 匿名身份 = admin 走 ①②；③ 用真 member 账号（e2e-entry seed member-e2e）。

test("f4 用户管理：建→停用→恢复 + 搜索 + Sidebar 双态", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toContainText("会话", { timeout: 10_000 });

  // 底部用户行 hover 弹菜单 →「管理」→ /admin/users
  await page.locator("[data-testid=user-footer]").hover();
  await page.locator("button", { hasText: "管理" }).click();
  await expect(page.locator("h1")).toHaveText("用户管理", { timeout: 5_000 });

  // Sidebar 切 admin 态：返回对话 + 管理菜单；会话列表不在
  await expect(page.locator("button", { hasText: "返回对话" })).toBeVisible();
  await expect(page.locator("[data-testid^=ws-toggle-]")).toHaveCount(0); // 手风琴组头不在 admin 态

  // 新建用户（弹窗；唯一名防重跑碰撞）
  const uname = `u${Date.now().toString(36).slice(-6)}`;
  await page.locator("[data-testid=open-create-user]").click();
  await page.locator("[data-testid=new-username]").fill(uname);
  await page.locator("input[placeholder='初始密码']").fill("pw-f4-e2e-1");
  await page.locator("[data-testid=create-user]").click();
  await expect(page.locator(`text=@${uname}`)).toBeVisible({ timeout: 5_000 });

  // 搜索过滤：搜 uname → 表格只剩该行
  await page.locator("[data-testid=user-search]").fill(uname);
  await expect(page.locator("[data-testid=users-table] tbody tr")).toHaveCount(1, { timeout: 3_000 });
  // 搜不存在的词 → 空态
  await page.locator("[data-testid=user-search]").fill("no-such-user-xyz");
  await expect(page.locator("text=无匹配用户")).toBeVisible({ timeout: 3_000 });
  await page.locator("[data-testid=user-search]").fill("");

  // 停用 → 徽标 + 恢复钮
  const row = page.locator("[data-testid=users-table] tbody tr", { hasText: uname });
  await row.locator("button", { hasText: "停用" }).click();
  await expect(row).toContainText("已停用", { timeout: 5_000 });
  await row.locator("button", { hasText: "恢复" }).click();
  await expect(row).not.toContainText("已停用", { timeout: 5_000 });

  // 返回对话 → Sidebar 回 chat 态
  await page.locator("button", { hasText: "返回对话" }).click();
  await expect(page.locator("[data-testid=ws-toggle-company]")).toBeVisible({ timeout: 5_000 }); // 公司组头回来
});

test("f4 workspace 管理：建（slug 自动）→ 编辑弹窗改名 + 搜索", async ({ page }) => {
  await page.goto("/admin/workspaces");
  await expect(page.locator("h1")).toHaveText("Workspace 管理", { timeout: 10_000 });

  // 新建弹窗：name + 全员开关（slug 不暴露）
  const wsName = `ws-${Date.now().toString(36).slice(-6)}`;
  await page.locator("[data-testid=open-create-ws]").click();
  await page.locator("[data-testid=new-ws-name]").fill(wsName);
  await page.locator("[data-testid=create-ws]").click();
  const row = page.locator("[data-testid=ws-table] tbody tr", { hasText: wsName });
  await expect(row).toBeVisible({ timeout: 5_000 });

  // 搜索：命中 1 行
  await page.locator("[data-testid=ws-search]").fill(wsName);
  await expect(page.locator("[data-testid=ws-table] tbody tr")).toHaveCount(1, { timeout: 3_000 });
  await page.locator("[data-testid=ws-search]").fill("");

  // 编辑弹窗：改名 → 保存 → 表格更新
  await row.locator("button", { hasText: "编辑" }).click();
  await page.locator("[data-testid=edit-ws-name]").fill(wsName + "-v2");
  await page.locator("[data-testid=edit-ws-save]").click();
  await expect(page.locator("[data-testid=ws-table] tbody tr", { hasText: wsName + "-v2" })).toBeVisible({ timeout: 5_000 });
});

test("f4 member 无权限：直输 /admin/users → 无权限页", async ({ page }) => {
  // 真 member 身份：API 登录拿 token 直塞 localStorage（UI /login 对匿名态会立即重定向回 /，
  // 无法走表单——这里只测权限页本身）。member-e2e 由 e2e-entry seed。
  const req = await page.request.post("/auth/login", { data: { username: "member-e2e", password: "member-e2e-pw-1" } });
  expect(req.ok()).toBe(true);
  const { token } = (await req.json()) as { token: string };
  await page.goto("/");
  await page.evaluate((t) => localStorage.setItem("agentany.token.v1", t), token);
  await page.reload();

  await expect(page.locator("text=E2E Member")).toBeVisible({ timeout: 10_000 });

  // member 的用户菜单无「管理」项（hover 弹出后验证），只有登出
  await page.locator("[data-testid=user-footer]").hover();
  await expect(page.locator("button", { hasText: "管理" })).toHaveCount(0);
  await expect(page.locator("button", { hasText: "登出" })).toBeVisible();

  // 直输 URL → 无权限页（非重定向）
  await page.goto("/admin/users");
  await expect(page.locator("text=无权限")).toBeVisible({ timeout: 5_000 });

  // 清 token（不污染串行后续 spec 的匿名态）
  await page.evaluate(() => localStorage.removeItem("agentany.token.v1"));
});
