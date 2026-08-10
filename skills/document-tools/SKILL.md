---
name: document-tools
description: Read PDF/DOCX and convert between PDF and DOCX formats. Use when a task needs to extract text/content from a PDF or Word document, or convert a document between PDF and DOCX. Routes to anydoc (read), OfficeCLI (docx read/edit + docx→pdf), and tools/pdf2docx (pdf→docx).
---

# document-tools

agentany 的文档基础能力路由：读 PDF/DOCX、PDF↔DOCX 互转。全部能力都可被 Pi / Claude Code 调用。

## 能力矩阵

| 能力 | 工具 | 命令 |
|------|------|------|
| 读任意文档（PDF/DOCX/PPT/XLSX/…） | anydoc | `npx -y @firecrawl/anydoc <file>` |
| 读/编辑 DOCX（文本/结构/渲染） | OfficeCLI | `officecli view <file> text\|outline\|html` |
| DOCX→PDF | docx2pdf（自封装） | `bash tools/docx2pdf/run.sh <in.docx> <out.pdf>` |
| PDF→DOCX | pdf2docx（自封装） | `bash tools/pdf2docx/run.sh <in.pdf> <out.docx>` |

## 使用要点

- **读文档**：优先 anydoc，输出干净的 GFM Markdown，LLM 可直接消费。大文档用 `-o out.md` 落盘再分段读。
- **扫描/图片型 PDF 需 OCR**，anydoc 不支持：失败打印 `anydoc: <message>` 到 stderr（exit 1）。
- **DOCX 结构/排版**：OfficeCLI `view text/outline/html`；`--json` 拿结构化输出；`view html` 可"看"排版。修改 docx 后需 `close`（或 `save`）落盘再让其他程序读。
- **DOCX→PDF**：`tools/docx2pdf/run.sh`（officecli `view html` 渲染 + Chrome headless `--no-pdf-header-footer` 打印）。**勿用** `officecli view <file> pdf`——需要未发布的 exporter 插件。docx 若被 officecli resident 持有，先 `close`。
- **PDF→DOCX**：仅此一路（OfficeCLI 只导出 PDF、不导入）。pdf2docx 保版式但为文本框式转换，复杂排版有损。

## 安装

- anydoc：零安装（`npx -y` 即拉即用）。也可 `npx skills add firecrawl/anydoc` 装官方 skill（写入 `.agents/skills/`）。
- OfficeCLI：`npm i -g @officecli/officecli`（自带运行时，无需 dotnet）或 `brew install officecli`。
- docx2pdf：无额外安装（officecli + 本机 Chrome，可用 `CHROME_BIN` 覆盖 Chrome 路径）。
- pdf2docx：`uv venv tools/pdf2docx/.venv --python 3.12 && uv pip install --python tools/pdf2docx/.venv -r tools/pdf2docx/requirements.txt`
