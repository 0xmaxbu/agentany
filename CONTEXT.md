# 文档基础能力（document-tools）

读 PDF/DOCX、PDF↔DOCX 互转的 agent 基础能力。详见 `skills/document-tools/SKILL.md`。

| 能力 | 工具 | 命令 |
|------|------|------|
| 读任意文档 | anydoc | `npx -y @firecrawl/anydoc <file>` |
| 读/编辑 DOCX | OfficeCLI | `officecli view <file> text\|html` |
| DOCX→PDF | docx2pdf（自封装） | `bash tools/docx2pdf/run.sh <in.docx> <out.pdf>` |
| PDF→DOCX | pdf2docx（自封装） | `bash tools/pdf2docx/run.sh <in.pdf> <out.docx>` |

# 品牌战略调研工作流（brand-strategy-research）

输入品牌名 → Tavily 网络调研 → 产出切入角度 → 用户多选 → 生成品牌战略升级报告（Markdown）。Pi 全程驱动。

- 实现：`tools/brand-research/skills/brand-strategy-research/SKILL.md`
- 依赖：`tools/brand-research/extensions/web-search.ts`（Tavily 定制搜索：web_search/web_extract/web_crawl）
- key：`.env` 的 `TAVILY_PROXY_API_KEY`（thb-xxx）
- 运行：`pi install ./tools/brand-research -l` → `pi` → `/skill:brand-strategy-research <品牌名>`
- 定义：`workflows/brand-strategy-research.md`

## 术语表

| 术语 | 含义 |
|------|------|
| Pi | [earendil-works/pi](https://github.com/earendil-works/pi) 的 AI agent toolkit，本项目的执行引擎（编码 agent CLI，本机全局安装 v0.83.0） |
| 工作流 (workflow) | 一个定义好的、可重复执行的流程：目标、步骤、输入、输出、验证。见 `workflows/` |
| 经验文档 (learning) | 一次运行后沉淀的结论/教训，带证据和适用场景。见 `learnings/` |
| Skill | 成熟的经验固化为 agent 可直接调用的能力（SKILL.md）。见 `skills/` |
