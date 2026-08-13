// makeRunPi / makeRunPiStream：按 scope 装配 pi cwd + sessionDir（ticket #10，不再硬编码 project 路径）。
// makeRunPi（工作流 run）总是 project-scoped；makeRunPiStream（chat 会话）可 general（projectId=null）。
// cwd/sessionDir 由 src/scope.ts 的 resolveScopePaths 解析；sessionId 由调用方派生。
import { runPi, runPiStream, type RunPiOptions, type RunPiStreamOptions } from "./runPi";
import { resolveScopePaths, scopeOf, type Scope } from "../scope";
import type { BridgeChannel } from "../bridge/server";
import type { RunPiResult } from "../workflow-engine/defineWorkflow";

export interface MakeRunPiOpts {
  extensions?: string[];
  scope: Scope; // project | general（ticket #14：run scope 取自会话）
  projectId: string | null; // project scope 必填；general 为 null
  sessionId: string;
}
// chat 会话可 general（projectId=null）；路径按 scope 解析（ADR-0009 / ticket #10）。
export interface MakeRunPiStreamOpts {
  extensions?: string[];
  projectId: string | null;
  sessionId: string;
}

export type ConfiguredRunPi = (call: { prompt: string; timeoutMs?: number }) => Promise<RunPiResult>;

export function makeRunPi(opts: MakeRunPiOpts): ConfiguredRunPi {
  const { cwd, sessionDir } = resolveScopePaths(opts.scope, opts.projectId);
  return async (call) => {
    const rpOpts: RunPiOptions = {
      prompt: call.prompt,
      sessionId: opts.sessionId,
      sessionDir,
      cwd,
      extensions: opts.extensions,
      timeoutMs: call.timeoutMs,
    };
    return runPi(rpOpts);
  };
}

// makeRunPiStream（chat 用，ADR-0009）：绑 conversation 的 pi session（chat-<conversationId>），
// 每轮 prompt=仅新用户消息（pi session 持历史、不重喂）。call.signal 来自 per-conv 队列的 AbortController。
export type ConfiguredRunPiStream = (call: {
  prompt: string;
  onDelta: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  bridge?: BridgeChannel; // 每轮 bridge 通道（#11）
  appendSystemPrompt?: string[]; // --append-system-prompt（#15 chat 基础 system）
}) => Promise<RunPiResult>;

export function makeRunPiStream(opts: MakeRunPiStreamOpts): ConfiguredRunPiStream {
  const { cwd, sessionDir } = resolveScopePaths(scopeOf(opts.projectId), opts.projectId);
  return async (call) => {
    const rpOpts: RunPiStreamOptions = {
      prompt: call.prompt,
      sessionId: opts.sessionId,
      sessionDir,
      cwd,
      extensions: opts.extensions,
      timeoutMs: call.timeoutMs,
      signal: call.signal,
      onDelta: call.onDelta,
      appendSystemPrompt: call.appendSystemPrompt,
      // #11：bridge 通道——per-turn nonce 经 env 注入 pi。bridge-core 只读 url(含端口)+nonce，
      // 故不单独注 PORT（曾注 AGENTANY_BRIDGE_PORT 无人读 → 死字段已删）；port 仍经 loopbackPorts 用于沙箱窄放行。
      extraEnv: call.bridge
        ? { AGENTANY_BRIDGE_URL: call.bridge.url, AGENTANY_BRIDGE_NONCE: call.bridge.nonce }
        : undefined,
      loopbackPorts: call.bridge ? [call.bridge.port] : undefined,
    };
    return runPiStream(rpOpts);
  };
}
