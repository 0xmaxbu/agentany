// 共享 HTTP 请求小工具（去重：jsonBody 曾在 conversations/approvals/workflows/feedback/bridge 各自重复）。

/** 安全 JSON body：非 JSON / 空请求体 → {}。 */
export function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<any> {
  return c.req.json().catch(() => ({}) as any);
}
