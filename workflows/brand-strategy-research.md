# 工作流：品牌战略升级调研（brand-strategy-research）

## 目标

输入品牌名和地区（**缺省重庆**），进行行业+竞品+品牌差异+消费者网络调研（含**市场占有率**），产出多个经过**逻辑推理验证**的品牌战略升级切入点，用户多选后，从所选角度生成品牌战略升级报告（Markdown）。

**报告定位（红线）**：报告是**战略层交付物**，只描述**设计工作范围与目标**（需要设计什么、解决什么战略问题），**不涉及具体设计样式**（配色/字体/图形/工艺/版式等）——具体样式是设计师的工作，报告预设样式会让客户产生不符合实际设计的预期。

业务场景：为**品牌设计、包装、视觉系统**的设计及制作服务客户做品牌战略升级咨询。

## 输入

- 品牌名（必填）+ 地区（可选，缺省"重庆"），作为 `/skill:brand-strategy-research <品牌> [地区]` 的参数
- 前置：`.env` 已配 `TAVILY_PROXY_API_KEY`（Tavily proxy 网关 key）

## 步骤

1. 输入品牌 + 地区（来自 skill 参数，地区缺省重庆）
2. **调研** 5 块（用 `web_search`/`web_extract`/`web_crawl`，带来源 URL 写入 `.work/brand-research/<brand>/research-notes.md`）：
   - 行业基本面（含地区市场）
   - **竞争格局与市场占有率**（门店数/市占率/本地 vs 全国连锁）
   - **品牌差异分析**（vs 竞品的差异点与空白）
   - 品牌诊断
   - 消费者（含地区客群）
3. **产出角度**：4-6 个设计导向切入角度，每个必须过**逻辑推理验证**（证据链/反例/一致性/可行性），**只写设计工作范围、不给具体设计样式**，写 `angles.md` 并展示
4. **用户选择**：会话中请用户回复角度编号（可多选）
5. **生成报告**：按所选角度生成 `reports/<品牌>-<地区>品牌战略升级报告.md`，**战略层交付、不含具体设计样式**，含服务范围与交付映射

## 输出

- `.work/brand-research/<brand>/research-notes.md` — 调研笔记（中间产物）
- `.work/brand-research/<brand>/angles.md` — 候选角度（含逻辑验证摘要）
- `.work/brand-research/<brand>/selection.md` — 用户选择
- `reports/<品牌>-<地区>品牌战略升级报告.md` — 最终报告（客户交付物）

## 验证

- 调研笔记含**市场占有率**数据与竞品差异分析，且带来源 URL（非编造）
- 角度 4-6 个，每个含战略逻辑 + **逻辑验证** + 设计工作范围 + 服务范围映射
- **报告不含具体设计样式**（无配色/字体/图形/工艺/版式等具体方案，只写工作范围与目标）
- 报告结构完整（摘要/调研含市占率/机会点/角度深化含逻辑验证/**服务范围与交付**/落地路线）

## 实现

- 实现：`tools/brand-research/skills/brand-strategy-research/SKILL.md`（工作流 skill）
- 依赖工具：`tools/brand-research/extensions/web-search.ts`（Tavily 搜索扩展：web_search/web_extract/web_crawl）
- 安装：`pi install ./tools/brand-research -l`
- 运行：`pi` 进 TUI → `/skill:brand-strategy-research <品牌> [地区]`

## 经验引用

- `learnings/brand-strategy-research.md`（首版搭建与实测）
- 后续迭代经验沉淀到 `learnings/`
