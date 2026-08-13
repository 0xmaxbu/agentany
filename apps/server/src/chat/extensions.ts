// chat turn 注入的扩展（ADR-0009 / ticket #12）：
// - chat-bridge：桥接工具骨架（ping 验通道；后续票加 start_workflow/resume_workflow/ask_user/read_run）。
// - tavily web-search：基础网络能力（ADR-0009 Q5 默认开）。
// 工作流 agent 步【不】注入 chat-bridge——工作流经 wf.extensions 自行声明（见 registry/workflows）。
import { chatExtensionPath, repoExtensionPath } from "../config";

export const CHAT_EXTENSIONS: string[] = [
  chatExtensionPath("extensions/chat-bridge.ts"),
  repoExtensionPath("tavily-search/extensions/web-search.ts"),
];
