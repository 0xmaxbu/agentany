# 文档基础能力：网络 Skill 调研与实践

## 结论

4 个文档基础能力（读 PDF、读 DOCX、DOCX→PDF、PDF→DOCX）中 **2 个直接复用现成网络 skill，2 个自封装**（DOCX→PDF 调研时误判为可复用，实际有插件缺口）。

| 能力 | 方案 | 类型 |
|------|------|------|
| 读 PDF/DOCX/PPT/XLSX… | anydoc（Firecrawl，`npx -y @firecrawl/anydoc`） | 现成 skill，零安装 |
| 读/编辑 DOCX | OfficeCLI（iOfficeAI，`npm i -g @officecli/officecli`） | 现成 skill，自带运行时 |
| DOCX→PDF | `tools/docx2pdf/run.sh`：officecli `view html` + Chrome headless 打印 | 自封装（轻量） |
| PDF→DOCX | `tools/pdf2docx/run.sh`：pdf2docx（Python，基于 pymupdf，保版式） | 自封装 |

## 证据

- anydoc 官方 agent skill：`npx skills add firecrawl/anydoc`，SKILL.md 为 `convert-documents-to-markdown`；本机 `npx -y @firecrawl/anydoc --help` 验证可用（v0.1.7）。
- OfficeCLI 官方 SKILL.md 在 `https://officecli.ai/SKILL.md`；本机 `officecli --version` → 1.0.143（npm 包自带 .NET 运行时，**无需单独装 dotnet**）。
- **OfficeCLI `view pdf` 实际不可用**：报 `No exporter plugin found for .docx → .pdf`；`plugins list` 显示 0 插件，官方仓库只有 plugin-protocol.md、无现成插件（插件生态 pre-release）。**调研结论与实测不符，以实测为准**。
- DOCX→PDF 轻量路径实测打通：`officecli view html`（高保真渲染）+ Chrome `--headless --no-pdf-header-footer` 打印 → PDF，anydoc 读回干净无 `file://` 噪音。
- **Chrome flag 细节**：去页眉页脚用 `--no-pdf-header-footer` **单独使用**；与 `--print-to-pdf-no-header` 混用反而失效（实测 combo 噪音行 2 vs 0）。
- pdf2docx 为 Python 生态主流保版式 PDF→DOCX；PyPI 0.5.13，依赖 pymupdf（本机 python3.12 + uv 装 cp312 wheel 顺利）。
- anthropics 官方仓库另有 `skills/docx`（Word 创建/编辑），DOCX 侧备选。

## 为什么

- **先调研再造轮子**：本次网络调研省去 2/4 重复实现。但**调研≠实测**——OfficeCLI 的 `view pdf` 营销上"自带"，实际插件缺口，必须实测验证（对应本项目"无证据即推测"原则）。
- **OfficeCLI 比 LibreOffice 更适合 agent**：单二进制、`--json` 结构化输出、resident 模式、内置 HTML 渲染"给 AI 眼睛"。DOCX→PDF 因此不需要 LibreOffice（600MB）或 dotnet。

## 适用场景 / 边界

- **anydoc 不读扫描/图片型 PDF**（需 OCR，本机无 tesseract）→ 后续可加 OCR 能力。
- **pdf2docx 保版式但有损**：文本框式转换，非原生文档流，复杂排版（嵌套表格/浮动对象）会退化。
- **docx2pdf 分页/页眉可能轻微退化**：依赖 officecli 渲染 + Chrome 打印，复杂文档建议抽查。
- **OfficeCLI 不导入 PDF**：所以 PDF→DOCX 只能走 pdf2docx。
- officecli resident 模式持有文件时，其他程序读取前需先 `close`。
- 大文档先 `-o out.md` 落盘再分段读，避免灌爆 context。

## 相关

- [[document-tools]]（`skills/document-tools/SKILL.md`）
- `CONTEXT.md` 文档能力一节
