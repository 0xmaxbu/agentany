/**
 * chat-bridge —— chat turn 专属 pi 扩展（ticket #12）。
 * 经 bridge 通道（3199）回调服务端：pi 子进程内注册工具，execute 时 fetch 服务端（持 per-turn nonce）。
 * 骨架：ping 工具验通道；后续票在此加 start_workflow/resume_workflow/ask_user/read_run。
 *
 * 坐标从 env 读（AGENTANY_BRIDGE_URL/NONCE，由 chat turn 每轮注入；见 server chat/turn.ts）。
 * 本文件在 pi 进程加载（pi 自带 typebox/@earendil-works/pi-coding-agent），服务端不 import、tsc 不分析。
 * 纯逻辑（pingBridge/startWorkflow/readRun + withBridge 执行壳）在 ./bridge-core，双端可测。
 */
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pingBridge, startWorkflow, readRun, askUser, resumeWorkflow, withBridge } from "./bridge-core";

export default function chatBridge(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ping",
    label: "ping",
    description: "经 bridge 通道探活服务端（验 chat-bridge 扩展↔服务端通道打通）。无参数。",
    promptSnippet: "Ping the agentany server bridge",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(): Promise<AgentToolResult> {
      return withBridge("ping", process.env, (env) => pingBridge(env));
    },
  });

  pi.registerTool({
    name: "start_workflow",
    label: "start_workflow",
    description:
      "启动一个工作流异步执行（后台 subagent，run 不绑本 turn）。返 {runId, status}。进度（step_*/run_*）经持久流推回本对话。",
    promptSnippet: "Start a workflow in the background (workflowId, input)",
    parameters: Type.Object({
      workflowId: Type.String({ description: "工作流 id（见注入的工作流目录）" }),
      input: Type.Optional(Type.Any({ description: "工作流输入对象" })),
    }),
    executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult> {
      return withBridge("start_workflow", process.env, (env) => startWorkflow(env, params.workflowId, params.input));
    },
  });

  pi.registerTool({
    name: "read_run",
    label: "read_run",
    description: "读取一个 run 的状态 / 步骤 / 最新输出。",
    promptSnippet: "Read a workflow run status (runId)",
    parameters: Type.Object({ runId: Type.String({ description: "run id" }) }),
    executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult> {
      return withBridge("read_run", process.env, (env) => readRun(env, params.runId));
    },
  });

  pi.registerTool({
    name: "ask_user",
    label: "ask_user",
    description:
      "工作流挂起需用户决策时调用：创建结构化提问卡片（prompt + 选项按钮）。立即返回 {asked}、不阻塞；用户下一轮回答后系统自动判答并续跑。",
    promptSnippet: "Ask the user a structured question (cards) when a workflow is suspended",
    parameters: Type.Object({
      runId: Type.String({ description: "挂起的 run id" }),
      prompt: Type.String({ description: "向用户的提问" }),
      options: Type.Array(Type.String(), { description: "候选选项" }),
      resumeSchema: Type.Optional(Type.Any({ description: "续跑数据契约（可省，默认从 run 取）" })),
      multiple: Type.Optional(Type.Boolean({ description: "是否多选（v1 单选）" })),
    }),
    executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult> {
      return withBridge("ask_user", process.env, (env) => askUser(env, {
        runId: params.runId, prompt: params.prompt, options: params.options,
        resumeSchema: params.resumeSchema, multiple: params.multiple,
      }));
    },
  });

  pi.registerTool({
    name: "resume_workflow",
    label: "resume_workflow",
    description:
      "用归一化后的用户答案续跑挂起的工作流。仅在判定用户本次消息确实回答了待处理提问时调用；否则正常回应用户。",
    promptSnippet: "Resume a suspended workflow with the normalized answer (runId, resumeData)",
    parameters: Type.Object({
      runId: Type.String({ description: "挂起的 run id" }),
      resumeData: Type.Any({ description: "归一化的续跑数据（符合续跑契约）" }),
    }),
    executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult> {
      return withBridge("resume_workflow", process.env, (env) => resumeWorkflow(env, params.runId, params.resumeData));
    },
  });
}
