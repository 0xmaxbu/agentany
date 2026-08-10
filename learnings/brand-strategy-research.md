# 品牌战略升级调研工作流：搭建与实测

## 结论

用 **Pi 全程驱动**实现"输入品牌名 → 网络调研 → 产出切入角度 → 用户多选 → 生成品牌战略升级报告"定制工作流。核心是给 Pi 补一个**定制搜索扩展**（Pi 无内置网络搜索），工作流本身是一个 **Pi skill**（SKILL.md）。

## 证据

- E2E 实测（2026-08-10，瑞幸咖啡，DeepSeek V4 Flash）：调研 4 块全带来源 URL（43 处）、产出 6 个设计导向角度、报告结构完整（摘要/调研/机会点/角度深化/VI/包装/18 个月落地路线），全部断言通过。
- Pi 内置工具仅 read/bash/edit/write/grep/find/ls，无网络搜索；联网靠 bash curl 或扩展注册 fetch 工具。
- Tavily proxy 网关 `https://tavily.sharyuke.com/api/proxy/{search,extract,crawl}`，Bearer key，响应 `{code, data:{ok, data:<Tavily原文>}}`；直连实测返回真实市场数据。
- Pi 扩展加载：jiti 自动把 `typebox`、`@earendil-works/pi-coding-agent` 别名到 Pi 内置（`dist/core/extensions/loader.js` 的 getAliases），扩展无需自己装依赖。
- Pi 自定义 provider：`~/.pi/agent/models.json`（用户级）配 `{providers: {go: {baseUrl, api:"openai-completions", apiKey, models:[...]}}}`；默认用 `settings.json` 的 `defaultProvider`/`defaultModel`。
- **apiKey 从 .env 读**：Pi 不自动加载 .env，用 `apiKey: "!grep '^KEY=' .env | cut -d= -f2- | tr -d '\\r\\n'"`（`!command` 在 Pi 进程 cwd 执行，输出即值，结果按进程缓存）。**必须从仓库根启动 Pi**。

## 为什么

- 工作流本质需要联网调研，而 Pi 没有搜索 → 定制扩展是最符合"Pi 全程执行"的方案（相比在 Claude Code 里跑，搜索工具对模型是原生工具调用，模型自主编排调研）。
- 搜索网关选 Tavily proxy 是用户指定（有可用 key）；exa MCP 端点虽免 key 可用，但不在需求内。
- 角度必须**设计导向**（业务做品牌设计/包装/视觉系统），所以 skill 里明确角度要含"设计动作/可行性"，报告含 VI/包装/落地路线章节。

## 适用场景 / 边界

- **key 集中存 `.env`**（`TAVILY_PROXY_API_KEY` + `GO_API_KEY`），gitignore 掉；Pi 的 go provider 和扩展都从 `.env` 读。
- **`!command` 依赖 cwd**：从仓库根启动 Pi 才能读到 `.env`；换个目录会 key 缺失报错。
- **交互阶段（角度多选）依赖 Pi 交互式会话**；`--print`/`--no-session` 模式下要显式告知"用户已选角度 N"（测试用）。
- 调研质量取决于网关返回 + 模型综合能力；复杂/扫描型内容不在支持范围。
- Pi 默认 provider 若失效（如旧 google token 401），用 `settings.json` 的 `defaultProvider` 切到可用 provider。

## 报告红线（客户交付关键规则）

**报告是战略层交付物，不涉及具体设计样式**（配色/字体/图形/工艺/版式/材质）。原因：报告预设样式会让客户对实际设计产生**不符合现实的预期**——具体样式是设计师的工作，由设计阶段提案。

- 报告中设计相关内容只写**工作范围与目标**："需要建立支撑 X 定位的视觉识别体系 / 需要重构包装体系以解决 Y 问题"
- 允许描述品牌**现状**的设计特征（诊断事实，如"红白配色"），但不得给出新方案样式
- 模型实测会自行在 5/6 节末尾加免责声明："具体配色/字体/工艺由设计阶段提案，本报告不预设"
- 已写入 `SKILL.md` 的"报告红线"节 + 工作流定义验证项

## 配额教训

- Tavily 网关配额耗尽（`42901 Credit 不足`）会真实发生；扩展已增强报错，能直接识别"配额不足"给出处理建议（等恢复/换 key/升级）
- 配额耗尽时 skill 正确**停止并拒绝编造数据**（宁可无产出也不产出假报告）——这是"不编造"规则的自动执行
- E2E 每次全量跑会消耗较多配额，验证时可先用小品牌或控制搜索次数

## 相关

- [[document-tools]]（文档能力，工作流可复用的基础工具）
- `tools/brand-research/`（实现）、`workflows/brand-strategy-research.md`（定义）
