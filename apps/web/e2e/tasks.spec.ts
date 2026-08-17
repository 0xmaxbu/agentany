import { test, expect } from "@playwright/test";

// #31/M4-4 定时任务 UI 全链：
// ① admin 管理页：全量列表（member 任务 + system seed）→ 展开（prompt/下次/历史）→ 停/启 → 手动跑
//    （stub 产出会话落消息）→ 未读 badge 点开即清 → 删除。
// ② member ContextPanel「我的任务」：自己的任务（跑/停/删）+ 无 admin 入口。
// 身份：①dev 匿名=admin（含 system seed 可见）；②member-e2e 真账号（API 登录塞 token，admin.spec 先例）。
//
// #40/M6-2 admin system 任务弹窗（ADR-0023）：③新建弹窗全流程（填表→提交→列表新行）
// ④编辑弹窗改 cron（nextFire 重算生效）⑤蒸馏 seed 编辑仅 cron 可改（prompt 只读+说明）。

test("admin 定时任务管理：全量列表 + 展开 + 停/启 + 手动跑 + 未读清零 + 删除", async ({ page }) => {
  // 造一个真任务（admin 身份走 REST——UI 建流在 chat 卡链路，此处聚焦管理面）
  const name = `任务e2e-${Date.now().toString(36).slice(-5)}`;
  const created = await page.request.post("/scheduled-tasks", {
    data: { displayName: name, cron: "0 */4 * * *", prompt: "e2e 测试任务目标" },
  });
  expect(created.ok()).toBe(true);
  const taskId: string = ((await created.json()) as { id: string }).id;

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
  const runsBefore = (await (await page.request.get(`/scheduled-tasks/${taskId}/runs`)).json()) as { id: number }[];
  await row.locator("[data-testid=run-now]").click();
  await page.reload();
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: name }).first().locator("[data-testid=unread-badge]")).toBeVisible({ timeout: 5_000 });
  const row2 = page.locator("[data-testid=tasks-table] > div", { hasText: name }).first();
  await row2.locator("[data-testid=task-row]").click(); // 点开详情即清
  await page.reload();
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: name }).first().locator("[data-testid=unread-badge]")).toHaveCount(0, { timeout: 5_000 });

  // 删除（确认内联）→ 行消失（#39：删前等 run 收口——在跑 409）
  await waitForRunFinished(page, taskId, runsBefore.length ? runsBefore[runsBefore.length - 1].id : null);
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

  // 删除（确认）→ 面板消失（#39：删前等 run 收口——在跑 409）
  await waitForRunFinished(page, taskId, null);
  await page.locator("[data-testid=my-task-item]", { hasText: name }).locator("button[title='删除']").click();
  await page.locator("[data-testid=my-task-item]", { hasText: name }).locator("button", { hasText: "删" }).click();
  await expect(page.locator("[data-testid=my-task-item]", { hasText: name })).toHaveCount(0, { timeout: 5_000 });

  // 无 admin 入口：用户菜单无「管理」
  await page.locator("[data-testid=user-footer]").hover();
  await expect(page.locator("button", { hasText: "管理" })).toHaveCount(0);

  // 清 token（串行后续 spec 回匿名态）
  await page.evaluate(() => localStorage.removeItem("agentany.token.v1"));
});

// #39 后 DELETE 撞在跑 → 409（与手动跑同口径）：删前等最新 run 收口（e2e 时序适配，非产品缺陷）。
async function waitForRunFinished(page: import("@playwright/test").Page, taskId: string, runId: number | null): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const r = await page.request.get(`/scheduled-tasks/${taskId}/runs`);
    if (r.ok()) {
      const runs = (await r.json()) as { id: number; finishedAt: string | null }[];
      const latest = runs[runs.length - 1];
      if (latest && latest.id !== runId && latest.finishedAt != null) return;
    }
    await new Promise((res) => setTimeout(res, 300));
  }
}

test("admin 新建 system 任务弹窗：填表（含权限开关）→ 提交 → 列表新行", async ({ page }) => {
  await page.goto("/admin/tasks");
  await expect(page.locator("h1")).toHaveText("定时任务", { timeout: 10_000 });

  await page.locator("[data-testid=task-create-btn]").click();
  const dlg = page.locator("[data-testid=task-dialog]");
  await expect(dlg).toBeVisible();

  // 范围区为固定 System（全域）徽标——无 ws 选择器
  await expect(dlg.locator("[data-testid=scope-badge]")).toHaveText("System（全域）");
  await expect(dlg.locator("select")).toHaveCount(0);

  const name = `系统巡检-${Date.now().toString(36).slice(-5)}`;
  await dlg.locator("[data-testid=task-form-name]").fill(name);
  await dlg.locator("[data-testid=task-form-cron]").fill("30 6 * * 2");
  await dlg.locator("[data-testid=task-form-prompt]").fill("巡检全部 ws 的产出目录并汇总异常");
  // 权限开关：关写（巡检类只读）+ 关搜索（默认已关，点一下开再关回验证交互）
  await dlg.locator("[data-testid=task-form-allowwrite]").click();
  await dlg.locator("[data-testid=task-form-allowsearch]").click();
  await dlg.locator("[data-testid=task-form-allowsearch]").click();
  // allowWrite 关 → 严格语义提示可见
  await expect(dlg.locator("[data-testid=readonly-note]")).toBeVisible();

  await dlg.locator("[data-testid=task-submit]").click();
  await expect(dlg).toHaveCount(0, { timeout: 5_000 });

  // 列表新行：名称 + cron + system 徽标
  const row = page.locator("[data-testid=tasks-table] > div", { hasText: name });
  await expect(row.first()).toBeVisible({ timeout: 5_000 });
  await expect(row.first()).toContainText("30 6 * * 2");
  await expect(row.first()).toContainText("system");

  // 清理（e2e 数据库复用）
  await row.first().locator("[data-testid=delete-task]").click();
  await page.locator("[data-testid=confirm-delete]").click();
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: name })).toHaveCount(0, { timeout: 5_000 });
});

test("admin 编辑 system 任务弹窗：预填 + 改 cron → 行内 cron 更新", async ({ page }) => {
  // 造一个 system 任务（REST admin 建——#39 放开面）
  const name = `可编辑任务-${Date.now().toString(36).slice(-5)}`;
  const created = await page.request.post("/scheduled-tasks", {
    data: { scope: "system", displayName: name, cron: "0 5 * * 1", prompt: "初始目标" },
  });
  expect(created.ok()).toBe(true);

  await page.goto("/admin/tasks");
  const row = page.locator("[data-testid=tasks-table] > div", { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });

  // 改前先展开记下「下次」（nextFireAt=旧 cron 的火点）——改 cron 后断言它变（服务端重算可观察）
  await row.locator("[data-testid=task-row]").click();
  const nextBefore = await row.locator("text=/下次：/").textContent();

  await row.locator("[data-testid=task-edit-btn]").click();
  const dlg = page.locator("[data-testid=task-dialog]");
  await expect(dlg).toBeVisible();
  // 预填现值
  await expect(dlg.locator("[data-testid=task-form-name]")).toHaveValue(name);
  await expect(dlg.locator("[data-testid=task-form-cron]")).toHaveValue("0 5 * * 1");
  await expect(dlg.locator("[data-testid=task-form-prompt]")).toHaveValue("初始目标");

  // 改 cron 提交 → 行内更新 + nextFireAt 重算生效（spec #40 验收点：改后可观察——review P1）
  await dlg.locator("[data-testid=task-form-cron]").fill("15 7 * * 3");
  await dlg.locator("[data-testid=task-submit]").click();
  await expect(dlg).toHaveCount(0, { timeout: 5_000 });
  const rowAfter = page.locator("[data-testid=tasks-table] > div", { hasText: name }).first();
  await expect(rowAfter).toContainText("15 7 * * 3", { timeout: 5_000 });
  // 展开态跨编辑保留（expanded 按行 id 记录）——直接断言「下次」已变（勿再点行=会收起）
  await expect(rowAfter.locator("text=/下次：/")).not.toHaveText(nextBefore ?? "", { timeout: 5_000 });
  // API 侧断言真值：nextFireAt 为新 cron（15 7 * * 3）火点（分钟位=15 稳定不受 TZ 影响；> now）
  const taskAfter = (await (await page.request.get("/scheduled-tasks")).json()) as { nextFireAt: string; cron: string; displayName: string }[];
  const mine = taskAfter.find((t) => t.cron === "15 7 * * 3" && t.displayName === name);
  expect(mine).toBeDefined();
  const nf = new Date(mine!.nextFireAt);
  expect(nf.getUTCMinutes()).toBe(15);
  expect(nf.getTime()).toBeGreaterThan(Date.now());

  // 清理
  await page.locator("[data-testid=tasks-table] > div", { hasText: name }).first().locator("[data-testid=delete-task]").click();
  await page.locator("[data-testid=confirm-delete]").click();
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: name })).toHaveCount(0, { timeout: 5_000 });
});

test("admin 新建弹窗 cron 校验：前端格式错即时可见 + 服务端过密 422 直出（review P3）", async ({ page }) => {
  await page.goto("/admin/tasks");
  await expect(page.locator("h1")).toHaveText("定时任务", { timeout: 10_000 });
  await page.locator("[data-testid=task-create-btn]").click();
  const dlg = page.locator("[data-testid=task-dialog]");
  await expect(dlg).toBeVisible();

  await dlg.locator("[data-testid=task-form-name]").fill("校验任务");
  await dlg.locator("[data-testid=task-form-prompt]").fill("x");

  // 前端粗校验：3 段 → 即时错误 + 提交禁用
  await dlg.locator("[data-testid=task-form-cron]").fill("0 5 *");
  await expect(dlg.locator("[data-testid=cron-format-error]")).toBeVisible();
  await expect(dlg.locator("[data-testid=task-submit]")).toBeDisabled();

  // 5 段但过密（*/5 分钟）→ 前端放行（格式对），服务端 422 → 错误直出、弹窗不关
  await dlg.locator("[data-testid=task-form-cron]").fill("*/5 * * * *");
  await expect(dlg.locator("[data-testid=cron-format-error]")).toHaveCount(0);
  await dlg.locator("[data-testid=task-submit]").click();
  await expect(dlg.locator("[data-testid=task-dialog-error]")).toContainText("too frequent", { timeout: 5_000 });
  await expect(dlg).toBeVisible(); // 未提交成功——弹窗仍在

  // 取消无副作用（列表无校验任务）
  await dlg.locator("button", { hasText: "取消" }).click();
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: "校验任务" })).toHaveCount(0);
});

test("蒸馏 seed 编辑弹窗：仅 cron 可编辑，prompt 只读 + 说明", async ({ page }) => {
  await page.goto("/admin/tasks");
  const seedRow = page.locator("[data-testid=tasks-table] > div", { hasText: "经验蒸馏" });
  await expect(seedRow).toBeVisible({ timeout: 10_000 });

  await seedRow.locator("[data-testid=task-edit-btn]").click();
  const dlg = page.locator("[data-testid=task-dialog]");
  await expect(dlg).toBeVisible();

  // 蒸馏形态：cron 可输入；prompt 只读展示 + 说明文案；displayName/权限开关不可编辑（禁用态）
  await expect(dlg.locator("[data-testid=task-form-cron]")).toBeEnabled();
  await expect(dlg.locator("[data-testid=task-form-prompt]")).toBeDisabled();
  await expect(dlg.locator("[data-testid=distill-note]")).toBeVisible();
  await expect(dlg.locator("[data-testid=task-form-name]")).toBeDisabled();
  await expect(dlg.locator("[data-testid=task-form-allowwrite]")).toBeDisabled();

  // 改 cron 可提交（唯一可改字段）
  await dlg.locator("[data-testid=task-form-cron]").fill("20 4 * * 4");
  await dlg.locator("[data-testid=task-submit]").click();
  await expect(dlg).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: "经验蒸馏" })).toContainText("20 4 * * 4", { timeout: 5_000 });

  // 蒸馏行无删除钮（冻结——不可新建第二个蒸馏、不可删）
  await expect(page.locator("[data-testid=tasks-table] > div", { hasText: "经验蒸馏" }).locator("[data-testid=delete-task]")).toHaveCount(0);
});
