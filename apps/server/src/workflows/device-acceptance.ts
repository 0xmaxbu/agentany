// R-6 真机验收工作流（#6 人工验收）：真 pi + 远端工具 stub → 桥 → 在线设备客户端。
// 覆盖：write 写入 / read 读回 / bash cat / browser 打开 Hacker News 抓头条（借用类工具触发设备授权弹窗）。
// 注：pi 内置同名工具会被 stub 覆写（2026-08-21 实测：stub bash 生效、内置 bash 不可达）。
import { defineWorkflow } from "../workflow-engine/defineWorkflow";
import { schema } from "../workflow-engine/schema";

export const deviceAcceptance = defineWorkflow({
  id: "device-acceptance",
  name: "设备真机验收",
  description: "R-6 真机验收：write/read/cat + browser 抓 Hacker News 头条（真 pi + 远端设备工具）",
  inputSchema: schema.object({ scratchDir: schema.optional(schema.string()) }),
  tools: ["write", "read", "bash", "browser.tabs", "browser.navigate", "browser.evaluate"],
})
  .step("demo", {
    async execute(ctx) {
      const scratch = ((ctx.input as { scratchDir?: string })?.scratchDir) ?? "/tmp/agentany-acceptance";
      const r = await ctx.runPi({
        prompt: [
          "你在验收一套「远端设备工具」系统：注册表里的 write/read/bash/browser.* 每次调用都会被转发到用户本人的电脑上执行（本机同名内置工具已被覆写，调 bash 即走远端）。依次完成：",
          `1. 用 write 工具写文件 ${scratch}/hello.txt，内容恰好一行：agentany r6 acceptance ok`,
          `2. 用 read 工具读回 ${scratch}/hello.txt，确认内容一致。`,
          `3. 用 bash 工具执行一次：cat ${scratch}/hello.txt`,
          "4. 用 browser 工具打开 https://news.ycombinator.com ，等加载完成后提取页面第一条新闻的标题和链接。",
          "完成后用中文汇报：步骤 1-3 各自的结果（含 cat 的输出原文），以及 Hacker News 当前第一条新闻的标题与链接。",
        ].join("\n"),
        timeoutMs: 600_000, // 设备端借用类工具有授权弹窗（60s 超时档）——留足人工点击时间
      });
      return { report: r.text };
    },
  })
  .commit();
