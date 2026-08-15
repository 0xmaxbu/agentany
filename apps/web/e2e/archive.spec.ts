import { test, expect, type Page } from "@playwright/test";

// #21/ADR-0020：会话归档与删除全链（用户视角）。
// e2e 环境 = dev 匿名身份（后端 dev 阀放行为 admin）→ 归档 + 删除菜单都可见。
// 流程：归档 → 主列表消失/归档区可见/composer 禁用 → 恢复 → 重现可发 → 删除 → 彻底消失。
// #命名：显示名不再含 id 尾码——条目唯一锚 = data-testid=conv-item-{id}（从 DOM 读回）。

/** 侧栏首条会话的 id（testid 锚）——列表已加载后调用。 */
async function firstConvId(page: Page): Promise<string> {
  const first = page.locator(".conv-list .item").first();
  await expect(first).toBeVisible({ timeout: 5_000 });
  return (await first.getAttribute("data-testid"))!.replace("conv-item-", "");
}

test("归档→只读→恢复→admin 删除全链", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 10_000 });

  // 会话 A 发一条消息（保证有内容可归档）
  await page.locator("textarea").fill("msgArch");
  await page.locator("textarea").press("Enter");
  await expect(page.locator(".bubble.assistant").last()).toContainText("你好", { timeout: 5_000 });
  await expect(page.locator("button.stop")).toHaveCount(0, { timeout: 5_000 });

  const aId = await firstConvId(page);
  const itemA = page.locator(`[data-testid=conv-item-${aId}]`);

  // 悬浮菜单：归档（按钮在 .item 的兄弟位——同包裹 div 内）
  await itemA.hover();
  await page.locator(".conv-list button[title='归档']").first().click();

  // 主列表 A 消失（归档乐观下架）。e2e 环境列表通常只有 A → 补位逻辑跳 / 新建 B，
  // 列表长度 -1+1 不变——但 A 的条目必须消失（修复前误报「归档没生效」的就是这个 -1+1）
  await expect(itemA).toHaveCount(0, { timeout: 5_000 });

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
  await expect(itemA).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("textarea")).toBeEnabled({ timeout: 5_000 });

  // admin 删除（悬浮菜单 → 确认）：A 项悬浮删除
  await itemA.hover();
  await itemA.locator("~ span button[title='删除（不可恢复）']").click();
  await page.locator("button", { hasText: "确认删除" }).click();
  await expect(itemA).toHaveCount(0, { timeout: 5_000 });

  // 刷新 → A 彻底消失（归档区也无）
  await page.reload();
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 10_000 });
  await expect(itemA).toHaveCount(0, { timeout: 3_000 });
});

test("归档当前会话且还有剩余会话 → 补位跳到剩余第一条（不新建）", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header .conv")).toBeVisible({ timeout: 10_000 });

  // 造两个会话：A（先建）+ B（后建，当前所在）。串行共享 dev-user——列表可能有前序 test 残留，全程相对断言。
  // 分页首屏异步（公司组 limit 10）——等首条 .item 出现再计数。
  await expect(page.locator(".conv-list .item").first()).toBeVisible({ timeout: 5_000 });
  const preCount = await page.locator(".conv-list .item").count(); // 含前序残留 + goto 自动新建的 1 条
  // A 首条消息 ≥8 字（#命名素材门槛）→ A 获得主题名，与 B 的「新会话」可区分（补位断言依赖 header 名切换）
  await page.locator("textarea").fill("convA 的第一条足够长的消息");
  await page.locator("textarea").press("Enter");
  await expect(page.locator("button.stop")).toHaveCount(0, { timeout: 5_000 }); // 等 A 流完
  await page.locator("[data-testid=ws-toggle-company]").hover(); // 组头 hover 显 +
  await page.locator("[data-testid=ws-new-company]").click();
  await expect(page.locator(".conv-list .item")).toHaveCount(preCount + 1, { timeout: 3_000 }); // B 建成

  const bId = await firstConvId(page);
  const itemB = page.locator(`[data-testid=conv-item-${bId}]`);
  const bName = (await itemB.textContent())!.trim(); // 归档前抓名（条目消失后 textContent 会等超时）

  // 归档当前 B → 补位跳剩余会话；列表长度 -1（不再 -1+1 恒定——修复的核心断言）
  await itemB.hover();
  await page.locator(".conv-list button[title='归档']").first().click();
  // header 切走 B = 补位导航已发生（navigate 在 PATCH 返回后——比乐观列表更新晚，须等待式断言）
  await expect
    .poll(async () => (await page.locator("header .conv").textContent()) ?? "", { timeout: 5_000 })
    .not.toContain(bName);
  await expect(page.locator(".conv-list .item")).toHaveCount(preCount, { timeout: 5_000 });
  await expect(itemB).toHaveCount(0, { timeout: 3_000 });
  // 补位到的是活跃会话（非归档只读态）
  await expect(page.locator("textarea")).toBeEnabled({ timeout: 5_000 });
});
