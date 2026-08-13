// brand-strategy-analysis：品牌战略升级·战略分析（HITL，3 步 + revise 循环）。
// select-angles（读 angles.json→suspend）→ generate-report（agent 写报告）→ approve-report（suspend，revise→循环）。
// 步间数据 echo-forward（每步输出带 brand/region/anglesPath/selected），保证 revise 循环不丢上下文。
import { defineWorkflow } from "../workflow-engine/defineWorkflow";
import { schema } from "../workflow-engine/schema";
import { slugify } from "../config";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// h2：brand/region 进文件路径前 slugify。
const brandDir = (cwd: string, brand: string, region: string) =>
  join(cwd, "brand-research", `${slugify(brand)}-${slugify(region)}`);

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
})
  .step("select-angles", {
    async execute({ input, resumed, cwd }) {
      const brand = String((input as any).brand);
      const region = String((input as any).region ?? "全国");
      const rawAngles = (input as any).anglesPath;
      let anglesPath = join(brandDir(cwd, brand, region), "angles.json");
      if (typeof rawAngles === "string" && rawAngles.length > 0) {
        // h2 路径卫生：caller 可控 anglesPath 必须解析后落在项目工作区内（防跨项目 / 任意文件读）。
        const resolved = resolve(cwd, rawAngles);
        if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
          throw new Error(`anglesPath escapes project workspace: ${rawAngles}`);
        }
        anglesPath = resolved;
      }

      if (resumed) {
        // resume → 默认链 generate-report；透传上下文 + 用户选择
        return {
          selected: String((resumed as any).selected),
          feedback: (resumed as any).feedback ?? null,
          brand, region, anglesPath,
        };
      }
      // 首跑（纯读、无副作用、不调 runPi）：读 angles → suspend
      let angles: unknown[] = [];
      try {
        angles = JSON.parse(await readFile(anglesPath, "utf8"));
      } catch {
        /* 无 angles.json → 空（前端提示先跑 brand-research）*/
      }
      return {
        __suspend: {
          payload: { angles, anglesPath, brand, region },
          resumeSchema: schema.object({
            selected: schema.string(), // "all" 或 "1,3,5"
            feedback: schema.optional(schema.string()),
          }),
        },
      };
    },
  })
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
  .step("approve-report", {
    async execute({ input, resumed }) {
      const ctx = {
        reportPath: (input as any).reportPath,
        summary: (input as any).summary,
        brand: (input as any).brand,
        region: (input as any).region,
        anglesPath: (input as any).anglesPath,
        selected: (input as any).selected,
      };
      if (resumed) {
        if ((resumed as any).decision === "revise") {
          // 循环回 generate-report，带 comments + 透传上下文（echo-forward）
          return { __next: "generate-report", comments: (resumed as any).comments ?? "", ...ctx };
        }
        return { approved: true, reportPath: ctx.reportPath };
      }
      return {
        __suspend: {
          payload: { reportPath: ctx.reportPath, excerpt: ctx.summary },
          resumeSchema: schema.object({
            decision: schema.enum("approve", "revise"),
            comments: schema.optional(schema.string()),
          }),
        },
      };
    },
  })
  .commit();
