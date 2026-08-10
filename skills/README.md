# skills — 沉淀的 agent skills

成熟的经验固化为 agent 可直接调用的 skill。

## 索引

- **document-tools** — 文档基础能力路由：读 PDF/DOCX、PDF↔DOCX 互转（复用 anydoc + OfficeCLI + 自封装 pdf2docx）

## 结构

```
skills/<name>/SKILL.md
```

遵循 standard skill 格式：frontmatter（`name`、`description`）+ 正文（何时用、怎么做）。

## 何时提升（门槛）

- 该经验被 2+ 个工作流复用
- 步骤稳定、可复现
- 能写成明确的触发条件（何时该用它）

## 如何被 Claude Code 使用

把 `skills/<name>` 链接（或复制）到 `~/.claude/skills/<name>/`：

```bash
ln -s "$PWD/skills/<name>" ~/.claude/skills/<name>
```

## 编写参考

创建/改进 skill 用 `/write-a-skill`（检查格式）、`/skill-creator`（格式 + 评估）。
