// brand-research：品牌战略升级·调研（全自动，1 步）。region 缺省「全国」。
// 调用 tavily-search 扩展 + brand-research 方法论 skill；产出 research-report.md + angles.json。
import { defineWorkflow } from "../workflow-engine/defineWorkflow";
import { schema } from "../workflow-engine/schema";
import { repoExtensionPath, slugify } from "../config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const TAVILY_EXT = repoExtensionPath("tavily-search/extensions/web-search.ts");
// h2：brand/region 进文件路径前 slugify（防 ../、shell 元字符注入 mkdir/prompt）。
const brandDir = (cwd: string, brand: string, region: string) =>
  join(cwd, "brand-research", `${slugify(brand)}-${slugify(region)}`);

export const brandResearch = defineWorkflow({
  id: "brand-research",
  name: "品牌战略升级·调研",
  description: "品牌+地区（缺省全国）→ 五块深度调研（含市占）→ 3-5 个经逻辑验证的切入角度。全自动。",
  inputSchema: schema.object({
    brand: schema.string(),
    region: schema.optional(schema.string()),
    focus: schema.optional(schema.string()), // 定向重跑
  }),
  extensions: [TAVILY_EXT],
})
  .step("research", {
    async execute({ input, runPi, cwd }) {
      const brand = String((input as any).brand);
      const region = String((input as any).region ?? "全国");
      const focus = (input as any).focus ? String((input as any).focus) : undefined;
      const dir = brandDir(cwd, brand, region);
      const reportPath = join(dir, "research-report.md");
      const anglesPath = join(dir, "angles.json");
      // ADR-0025 简报契约（#41/T1）：artifacts 用 **ws 相对路径**（/files/<ws>/<rel> 链接锚；绝对路径不下发）
      const relDir = join("brand-research", `${slugify(brand)}-${slugify(region)}`);
      const reportRel = join(relDir, "research-report.md");
      const anglesRel = join(relDir, "angles.json");

      const prompt = [
        `按 brand-research skill 方法论调研「${brand}」（地区：${region}）：五块（行业/竞争含市占/品牌差异/品牌诊断含战略沿革根因+消费者口碑/消费者），三层证据 [F]/[P]/[I] + 来源 URL，产出 3-5 个经逻辑验证、满足独到性门槛的切入角度。`,
        focus ? `定向补研 focus="${focus}"：先读已有 ${reportPath} 后扩展该方面，不从头重来。` : ``,
        `写调研报告 → ${reportPath}（人读）；写候选角度 → ${anglesPath}（JSON 数组 [{id,title,insight,evidence[],logicValidation,feasibility}]）。`,
        `目录不存在先 mkdir -p ${dir}。工具报错（key/配额）则报告错误并停。中文输出。`,
      ]
        .filter(Boolean)
        .join(" ");

      const r = await runPi({ prompt, timeoutMs: 600_000 });

      // 读回 angles.json（best-effort：stub/失败 → 空）
      let angles: unknown[] = [];
      try {
        angles = JSON.parse(await readFile(anglesPath, "utf8"));
      } catch {
        /* 文件可能不存在（stub runPi / 失败）*/
      }
      // ADR-0025 简报契约（#41/T1）：brief 首句直说结果（结论+关键数字），artifacts=ws 相对路径（白名单可点）
      return {
        angles, anglesSummary: r.text, reportPath, anglesPath, brand, region,
        brief: `「${brand}」（${region}）调研完成：已产出 ${angles.length} 个候选角度。报告：${reportRel}`,
        artifacts: [reportRel, anglesRel],
      };
    },
  })
  .commit();
