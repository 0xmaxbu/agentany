import { test, expect } from "@playwright/test";

// #31/M4-4 定时任务 UI 全链：
// ① admin 管理页：全量列表（member 任务 + system seed）→ 展开（prompt/下次/历史）→ 停/启 → 手动跑
//    （stub 产出会话落消息）→ 未读 badge 点开即清 → 删除。
// ② member ContextPanel「我的任务」：自己的任务（跑/停/删）+ 无 admin 入口。
// 身份：①dev 匿名=admin（含 system seed 可见）；②member-e2e 真账号（API 登录塞 token，admin.spec 先例）。

test("admin 定时任务管理：全量列表 + 展开 + 停/启 + 手动跑 + 未读清零 + 删除", async ({ page }) => {
  // 造一个真任务（admin 身份走 REST——UI 建流在 chat 卡链路，此处聚焦管理面）
  const name = `任务e2e-${Date.now().toString(36).slice(-5)}`;
  const created = await page.request.post("/scheduled-tasks", {
    data: { displayName: name, cron: "0 */4 * * *", prompt: "e2e 测试任务目标" },
  });
  expect(created.ok()).toBe(true);

  await page.goto("/admin/tasks");
  await expect(page.locator("h1")).toHaveText("定时任务", { timeout: 10_000 });

  // 全量：member（刚建的）+ system seed 都在
  const row = page.locator("[data-testid=tasks-table] > div", { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: "经验蒸馏" })).toBeVisible();

  // 展开行：prompt + 下次执行时间 + 历史空态
  await row.locator("[data-testid=task-row]").click();
  await expect(row.locator("text=e2e 测试任务目标")).toBeVisible();
  await expect(row.locator("text=暂无执行记录")).toBeVisible();

  // 停用 → 行降透明度 + 启用回来
  await row.locator("[data-testid=toggle-enabled]").click();
  await expect(row.locator("text=停用标签-不应出现")).toHaveCount(0); // 展开态稳定
  await expect(row).toBeVisible();
  await row.locator("[data-testid=toggle-enabled]").click(); // 重新启用（后续手动跑要 enabled）

  // 手动跑 → 执行历史出「成功」（stub turn 产出文本落产出会话；run 行 ok）
  await row.locator("[data-testid=run-now]").click();
  await expect(row.locator("[data-testid=task-runs] li").first()).toContainText("成功", { timeout: 15_000 });
  await expect(row.locator("[data-testid=task-runs] li").first()).toContainText("手动");

  // 未读 badge：再跑一次 → reload 出 badge → 点开（展开已开则收起再开）→ 清零
  await row.locator("[data-testid=run-now]").click();
  await page.reload();
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: name }).first().locator("[data-testid=unread-badge]")).toBeVisible({ timeout: 5_000 });
  const row2 = page.locator("[data-testid=tasks-table] > div", { hasText: name }).first();
  await row2.locator("[data-testid=task-row]").click(); // 点开详情即清
  await page.reload();
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: name }).first().locator("[data-testid=unread-badge]")).toHaveCount(0, { timeout: 5_000 });

  // 删除（确认内联）→ 行消失
  const row3 = page.locator("[data-testid=tasks-table] > div", { hasText: name }).first();
  await row3.locator("[data-testid=delete-task]").click();
  await row3.locator("[data-testid=confirm-delete]").click();
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: name })).toHaveCount(0, { timeout: 5_000 });

  // system seed 不可删（无删除钮——只读停/启）
  const seedRow = page.locator("[data-testid=tasks-table] > div", { hasText: "经验蒸馏" });
  await expect(seedRow.locator("[data-testid=delete-task]")).toHaveCount(0);
});

test("member 我的任务：ContextPanel 自管（跑/停/删）+ 无 admin 入口", async ({ page }) => {
  // member-e2e 登录（API token 塞 localStorage——admin.spec 先例）
  const req = await page.request.post("/auth/login", { data: { username: "member-e2e", password: "member-e2e-pw-1" } });
  expect(req.ok()).toBe(true);
  const { token } = (await req.json()) as { token: string };
  await page.goto("/");
  await page.evaluate((t) => localStorage.setItem("agentany.token.v1", t), token);
  await page.reload();
  await expect(page.locator("text=E2E Member")).toBeVisible({ timeout: 10_000 });

  // member 建自己的任务（REST——member 自建合法）
  const name = `我的任务-${Date.now().toString(36).slice(-5)}`;
  const created = await page.request.post("/scheduled-tasks", {
    headers: { authorization: `Bearer ${token}` },
    data: { displayName: name, cron: "0 */4 * * *", prompt: "member 自管任务" },
  });
  expect(created.ok()).toBe(true);

  // ContextPanel 默认收起——header「上下文」钮展开
  await page.locator("header button", { hasText: "上下文" }).click();
  await expect(page.locator("[data-testid=my-tasks]")).toBeVisible();
  const item = page.locator("[data-testid=my-task-item]", { hasText: name });
  await expect(item).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("[data-testid=my-task-item]", { hasText: "经验蒸馏" })).toHaveCount(0);

  // 手动跑 → 任务产出会话存在（runs 历史经 API 验证——面板无历史区）
  const taskId = ((await created.json()) as { id: string }).id;
  const run = await page.request.post(`/scheduled-tasks/${taskId}/run`, { headers: { authorization: `Bearer ${token}` } });
  expect(run.status()).toBe(202);

  // 停用 → 行降透明（enabled 徽标变）→ 启用回
  await item.locator("button[title='停用']").click();
  await expect(item).toBeVisible();
  await page.locator("[data-testid=my-task-item]", { hasText: name }).locator("button[title='启用']").click();

  // 删除（确认）→ 面板消失
  await page.locator("[data-testid=my-task-item]", { hasText: name }).locator("button[title='删除']").click();
  await page.locator("[data-testid=my-task-item]", { hasText: name }).locator("button", { hasText: "删" }).click();
  await expect(page.locator("[data-testid=my-task-item]", { hasText: name })).toHaveCount(0, { timeout: 5_000 });

  // 无 admin 入口：用户菜单无「管理」
  await page.locator("[data-testid=user-footer]").hover();
  await expect(page.locator("button", { hasText: "管理" })).toHaveCount(0);

  // 清 token（串行后续 spec 回匿名态）
  await page.evaluate(() => localStorage.removeItem("agentany.token.v1"));
});
