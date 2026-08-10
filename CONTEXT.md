# 文档基础能力（document-tools）

读 PDF/DOCX、PDF↔DOCX 互转的 agent 基础能力。详见 `skills/document-tools/SKILL.md`。

| 能力 | 工具 | 命令 |
|------|------|------|
| 读任意文档 | anydoc | `npx -y @firecrawl/anydoc <file>` |
| 读/编辑 DOCX | OfficeCLI | `officecli view <file> text\|html` |
| DOCX→PDF | docx2pdf（自封装） | `bash tools/docx2pdf/run.sh <in.docx> <out.pdf>` |
| PDF→DOCX | pdf2docx（自封装） | `bash tools/pdf2docx/run.sh <in.pdf> <out.docx>` |

## 术语表

| 术语 | 含义 |
|------|------|
| Pi | [earendil-works/pi](https://github.com/earendil-works/pi) 的 AI agent toolkit，本项目的执行引擎（编码 agent CLI，本机全局安装 v0.83.0） |
| 工作流 (workflow) | 一个定义好的、可重复执行的流程：目标、步骤、输入、输出、验证。见 `workflows/` |
| 经验文档 (learning) | 一次运行后沉淀的结论/教训，带证据和适用场景。见 `learnings/` |
| Skill | 成熟的经验固化为 agent 可直接调用的能力（SKILL.md）。见 `skills/` |
