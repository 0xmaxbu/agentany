# workflows — 工作流定义

每个文件定义一个可复用工作流。用 Pi 执行它，跑完把结果沉淀到 `learnings/` 和 `skills/`。

## 文件格式

每个工作流一个 Markdown 文件 `workflows/<name>.md`，包含：

- **目标** —— 一句话说清这个工作流要达成什么
- **输入** —— 需要什么（路径、参数、前置产物）
- **步骤** —— 有序步骤，每步可验证
- **输出** —— 产出的文件/产物在哪些路径
- **验证** —— 如何确认工作流成功
- **经验引用** —— 关联的 learnings/skills

## 如何用 Pi 执行

```bash
pi "按 workflows/<name>.md 执行工作流，完成后把结果沉淀为 learnings/<name>.md"
```

## 模板

```markdown
# 工作流：<name>

## 目标

## 输入

## 步骤

1. ...

## 输出

## 验证

## 经验引用

- learnings/...
- skills/...
```
