---
name: tavily-search
description: 网络搜索/提取/爬取能力（Tavily proxy 网关）。任何需要联网调研的工作流或对话可加载。提供 web_search/web_extract/web_crawl 三个工具。
---

# tavily-search —— 可复用网络调研能力

**独立、可复用**的搜索/爬取能力。需要联网的工作流（如 brand-research）或对话，通过扩展加载本 skill 的工具。不与任何具体工作流绑定。

## 工具（扩展：`extensions/web-search.ts`）

- `web_search(query, max_results?, search_depth?)` — Tavily 搜索，返回标题/URL/内容摘要。
- `web_extract(urls[])` — 提取网页正文（深读官网/报告/竞品页）。
- `web_crawl(url, max_depth?, limit?)` — 爬取站点。

## key

`TAVILY_PROXY_API_KEY`（环境变量或仓库根 `.env`）。缺 key / 配额不足时工具报错（调用方应停止并提示）。

## 加载（ADR-0005）

工作流声明 `extensions:["<repo>/skills/tavily-search/extensions/web-search.ts"]`（`-e` 显式加载工具）。对话/闲聊按 vetted 工具集加载。
