# 工作流：品牌战略升级·战略分析（brand-strategy-analysis）

> 源真相：`apps/server/src/workflows/brand-strategy-analysis.ts`。本文件为人类可读规格（衍生物，Q1）。
> 方法论 skill：`skills/brand-strategy-analysis/SKILL.md`。依赖 brand-research 的产出（angles.json + research-report.md）。

## 目标
读调研报告 + 候选角度 → 用户选定角度 → 生成战略升级报告（严守**红线**：不涉具体设计样式）→ 用户验收（可 **revise 循环**）。**HITL**。

## 输入
`{ brand: string, region?: string("全国"), anglesPath?: string }`。anglesPath 缺省 = 工作区 `brand-research/<brand>-<region>/angles.json`。

## 步骤（coded：3 步 + revise 循环）
1. **select-angles**（HITL，纯读 angles.json）：suspend 展示角度；resume `{selected:"all"|"1,3,5", feedback?}`。
2. **generate-report**（agent 步）：按方法论+红线对选中角度生成报告，写 `reports/<brand>-<region>-战略升级报告.md`。
3. **approve-report**（HITL）：suspend；resume `{decision:"approve"|"revise", comments?}`。revise → `__next:"generate-report"`（带 comments 循环）；approve → 终结。

## 产出（落项目工作区）
- `reports/<brand>-<region>-战略升级报告.md`

## 验证
- 报告含 执行摘要/核心洞察/调研发现/机会点/角度深化/视觉工作范围/包装工作范围/服务范围/落地路线。
- **红线**：无具体配色/字体/图形/工艺/版式，只写工作范围与目标。
- revise 循环生效（日志含多条 generate-report completed）。

## 测试
`apps/server/test/brand.test.ts`（stub runPi 验 select→generate→approve revise 循环 → completed）。
