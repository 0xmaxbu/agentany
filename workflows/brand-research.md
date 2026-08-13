# 工作流：品牌战略升级·调研（brand-research）

> 源真相：`apps/server/src/workflows/brand-research.ts`。本文件为人类可读规格（衍生物，Q1）。
> 方法论 skill：`skills/brand-research/SKILL.md`；搜索能力：`skills/tavily-search/`（可复用）。

## 目标
品牌+地区（缺省**全国**）→ 五块深度调研（行业/竞争含**市占**/品牌差异/品牌诊断含战略沿革根因+消费者口碑/消费者）→ 3-5 个经逻辑验证、满足独到性门槛的切入角度。**全自动**，人工验收（不足带 focus 重跑）。

## 输入
`{ brand: string, region?: string("全国"), focus?: string }`。focus = 定向重跑的方面。

## 步骤（coded：1 步）
1. **research**（agent 步，调 runPi + tavily）：按方法论五块调研（三层证据 [F]/[P]/[I]+来源），产 3-5 角度。focus 时读旧 report 补研。写 `research-report.md`（人读）+ `angles.json`（机读 `[{id,title,insight,evidence[],logicValidation,feasibility}]`）。

## 产出（落项目工作区 `data/projects/<projectId>/workspace/`）
- `brand-research/<brand>-<region>/research-report.md`
- `brand-research/<brand>-<region>/angles.json`

## 验证
- 调研报告含市占率 + 竞品差异 + 战略沿革根因 + 消费者口碑，带来源、三层证据标注。
- angles 3-5 个、每个含独到洞察 + 逻辑验证；angles.json 合法 JSON。
- run 输出含 `{angles, anglesSummary, reportPath, anglesPath}`。

## 重跑
不满意 → 新 run 带 `{brand, region, focus}`；读旧 research-report.md 补研。

## 测试
`apps/server/test/brand.test.ts`（stub runPi 验步结构）。
