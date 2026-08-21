// brand-strategy-analysis：品牌战略升级·战略分析（HITL，3 步 + revise 循环）。
// select-angles（读 angles.json→suspend）→ generate-report（agent 写报告）→ approve-report（suspend，revise→循环）。
// 步间数据 echo-forward（每步输出带 brand/region/anglesPath/selected），保证 revise 循环不丢上下文。
import { defineWorkflow } from "../workflow-engine/defineWorkflow";
import { ask } from "../workflow-engine/ask";
import { schema } from "../workflow-engine/schema";
import { slugify } from "../config";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// h2：brand/region 进文件路径前 slugify。
const brandDir = (cwd: string, brand: string, region: string) =>
  join(cwd, "brand-research", `${slugify(brand)}-${slugify(region)}`);

// anglesPath 解析（缺省 brand-research/<brand>-<region>/angles.json；caller 可控输入必须落在工作区内——防跨项目读）。
const resolveAnglesPath = (cwd: string, input: unknown): { anglesPath: string; brand: string; region: string } => {
  const brand = String((input as any).brand);
  const region = String((input as any).region ?? "全国");
  const rawAngles = (input as any).anglesPath;
  let anglesPath = join(brandDir(cwd, brand, region), "angles.json");
  if (typeof rawAngles === "string" && rawAngles.length > 0) {
    const resolved = resolve(cwd, rawAngles);
    if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
      throw new Error(`anglesPath escapes project workspace: ${rawAngles}`);
    }
    anglesPath = resolved;
  }
  return { anglesPath, brand, region };
};

export const brandStrategyAnalysis = defineWorkflow({
  id: "brand-strategy-analysis",
  name: "品牌战略升级·战略分析",
  description: "读调研报告+候选角度，用户选定 → 生成战略升级报告（严守红线：不涉具体设计样式）→ 验收（可 revise 循环）。",
  inputSchema: schema.object({
    brand: schema.string(),
    region: schema.optional(schema.string()),
    anglesPath: schema.optional(schema.string()), // 默认从工作区 brand-research/<brand>-<region>/angles.json 读
  }),
  extensions: [],
  tools: [], // 纯读写本地文件（skill 驱动），不调用外部工具
})
  .step("select-angles", ask({
    // #46/T3 ADR-0025 决策 5：显式 {label,value} 锁常见点击（"all"/"1,3,5"），截图打字路径仍走宽 schema 归一化。
    question: (input) => `「${String((input as any).brand)}」调研完成，请选择要深化的切入角度：`,
    context: async (input, { cwd }) => {
      const { anglesPath } = resolveAnglesPath(cwd, input);
      let angles: unknown[] = [];
      try {
        angles = JSON.parse(await readFile(anglesPath, "utf8"));
      } catch {
        /* 无 angles.json → 空（前端提示先跑 brand-research）*/
      }
      if (!Array.isArray(angles) || angles.length === 0) {
        return `（暂无可选角度——${anglesPath} 不存在或为空，请先运行「品牌战略升级·调研」）`;
      }
      return `已读候选角度（${angles.length} 个）：\n${angles
        .map((a, i) => `${i + 1}. ${String((a as any).title ?? (a as any).id ?? i + 1)}`)
        .join("\n")}`;
    },
    resumeSchema: schema.object({
      selected: schema.string(), // 自由形（"all" 或 "1,3,5"）——打字路径须接受任意选择
      feedback: schema.optional(schema.string()),
    }),
    options: [
      { label: "全部角度", value: { selected: "all" } },
      { label: "角度 1、3、5", value: { selected: "1,3,5" } },
    ],
    mapAnswer: (input, answer, { cwd }) => {
      const { anglesPath, brand, region } = resolveAnglesPath(cwd, input);
      return { ...(input as object), anglesPath, brand, region, selected: String((answer as any)?.selected), feedback: (answer as any)?.feedback ?? null };
    },
  }))
  .step("generate-report", {
    async execute({ input, runPi, cwd }) {
      const brand = String((input as any).brand);
      const region = String((input as any).region ?? "全国");
      const anglesPath = String((input as any).anglesPath);
      const selected = String((input as any).selected);
      const comments = (input as any).comments ? String((input as any).comments) : "";
      const reportDir = join(cwd, "reports");
      const reportPath = join(reportDir, `${slugify(brand)}-${slugify(region)}-战略升级报告.md`); // h2：slugify 防 ../ 逃目录

      const parts = [
        `按 brand-strategy-analysis skill 方法论 + 报告红线，为「${brand}」（${region}）生成战略升级报告。`,
        `读 ${anglesPath} 取角度、读同目录 research-report.md 取调研；只深化选中角度 selected="${selected}"。`,
        comments ? `修订意见：${comments}。` : ``,
        `写报告 → ${reportPath}（执行摘要/核心洞察/调研发现/机会点/角度深化/视觉工作范围/包装工作范围/服务范围/落地路线）。`,
        `严守红线：不出现具体配色/字体/图形/工艺/版式等设计样式，只写工作范围与目标。目录不存在先 mkdir -p ${reportDir}。中文。`,
      ];
      const prompt = parts.filter(Boolean).join(" ");

      const r = await runPi({ prompt, timeoutMs: 600_000 });
      return { reportPath, summary: r.text, brand, region, anglesPath, selected };
    },
  })
  .step("approve-report", ask({
    // #46/T3 ADR-0025 决策 5：打回修订循环用 route 表达（answer.decision==="revise" → generate-report）。
    question: () => "战略升级报告已生成，是否通过验收？",
    context: (input) => `报告：${String((input as any).reportPath)}\n\n执行摘要：${String((input as any).summary ?? "")}`,
    options: [
      { label: "批准", value: { decision: "approve" } },
      { label: "打回修订", value: { decision: "revise" } },
    ],
    resumeSchema: schema.object({
      decision: schema.enum("approve", "revise"),
      comments: schema.optional(schema.string()),
    }),
    mapAnswer: (input, answer) => ({
      ...(input as object), // echo-forward（reportPath/brand/region/selected 随行，revise 循环不丢上下文）
      approved: (answer as any).decision === "approve",
      comments: (answer as any).comments ?? "",
    }),
    route: (answer) => ((answer as any)?.decision === "revise" ? "generate-report" : undefined),
  }))
  .commit();
