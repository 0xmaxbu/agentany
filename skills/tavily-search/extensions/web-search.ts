/**
 * Tavily proxy 网关定制搜索扩展
 * 注册三个工具：web_search / web_extract / web_crawl
 * key 从 TAVILY_PROXY_API_KEY 环境变量或仓库根 .env 读取
 */
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadApiKey, proxyCall, resultsToText, ENV_KEY, type TavilyResult } from "./tavily-core";

export default function webSearch(pi: ExtensionAPI) {
  const key = loadApiKey();
  const requireKey = () => {
    if (!key) {
      throw new Error(
        `未找到 ${ENV_KEY}：请在仓库根 .env 填入 TAVILY_PROXY_API_KEY=thb-xxx，或设置环境变量。`
      );
    }
    return key;
  };

  pi.registerTool({
    name: "web_search",
    label: "web_search",
    description:
      "Tavily 网络搜索。输入自然语言 query，返回相关网页结果（标题/URL/内容摘要/相关度）。用于行业、品牌、竞品、消费者调研。",
    promptSnippet: "Search the web via Tavily (query, max_results)",
    parameters: Type.Object({
      query: Type.String({ description: "搜索查询，自然语言描述理想结果" }),
      max_results: Type.Optional(Type.Number({ description: "返回条数，默认 5" })),
      search_depth: Type.Optional(
        Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
          description: "搜索深度，默认 basic",
        })
      ),
    }),
    executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult> {
      try {
        const data = (await proxyCall(
          "search",
          {
            query: params.query,
            max_results: params.max_results ?? 5,
            search_depth: params.search_depth ?? "basic",
          },
          requireKey()
        )) as { results?: TavilyResult[] };
        return { content: [{ type: "text", text: resultsToText("搜索结果", data.results) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `web_search 失败: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "web_extract",
    label: "web_extract",
    description: "提取一个或多个网页的正文内容。输入 url 数组，返回每页正文。用于深读官网、行业报告、竞品页面。",
    promptSnippet: "Extract webpage content via Tavily (urls)",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), { description: "要提取的 URL 列表" }),
    }),
    executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult> {
      try {
        const data = (await proxyCall("extract", { urls: params.urls }, requireKey())) as {
          results?: TavilyResult[];
        };
        return { content: [{ type: "text", text: resultsToText("提取结果", data.results) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `web_extract 失败: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "web_crawl",
    label: "web_crawl",
    description: "爬取一个网站及其链接页面（按深度）。输入起始 url，返回抓到的页面内容。用于系统调研一个品牌/行业站点。",
    promptSnippet: "Crawl a website via Tavily (url, max_depth, limit)",
    parameters: Type.Object({
      url: Type.String({ description: "起始 URL" }),
      max_depth: Type.Optional(Type.Number({ description: "爬取深度，默认 2" })),
      limit: Type.Optional(Type.Number({ description: "最多抓取页数，默认 10" })),
    }),
    executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult> {
      try {
        const data = (await proxyCall(
          "crawl",
          { url: params.url, max_depth: params.max_depth ?? 2, limit: params.limit ?? 10 },
          requireKey()
        )) as { results?: TavilyResult[] };
        return { content: [{ type: "text", text: resultsToText("爬取结果", data.results) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `web_crawl 失败: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  });
}
