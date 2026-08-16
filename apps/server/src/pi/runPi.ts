// oneshot: pi -p --mode json NDJSON 驱动（Spike A step1 已证；pi --help 实证 flag）。
// **-p 必须有**（非交互处理即退，否则 pi 进交互模式挂起）。prompt=位置参数（spawn args 数组，不走 shell）。
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import "../config"; // 副作用：加载仓库 .env（runPi 读 PI_* / GO_API_KEY）
import { repoSkillPaths, repoSkillsDir } from "../config";
import { wrapSpawn } from "./sandbox";
import { createBlockEmitter, type StreamBlock } from "../blocks";
import type { RunPiResult } from "../workflow-engine/defineWorkflow";

export interface RunPiOptions {
  prompt: string;
  sessionId?: string;
  sessionDir?: string;
  cwd?: string;
  extensions?: string[]; // -e（显式；ADR-0005）。skills 走自动发现（repoSkillPaths），不在此声明。
  extraEnv?: Record<string, string | undefined>; // per-turn 注入（bridge nonce/url 等，#11）
  loopbackPorts?: number[]; // 沙箱 loopback 窄放行（bridge RPC，#11）
  appendSystemPrompt?: string[]; // --append-system-prompt（可多次；#15 chat 基础 system / #17 PROJECT.md）
  signal?: AbortSignal;
  timeoutMs?: number;
}

// 流式版（chat 用，ADR-0009 Q3 / f3 ADR-0019）：唯一增量回调 = onBlock 三帧（legacy onDelta 已删）。
export interface RunPiStreamOptions extends RunPiOptions {
  onBlock?: (b: StreamBlock) => void; // text/thinking/tool_use/tool_result 增量（见 blocks.ts）
}

function buildArgs(opts: RunPiOptions): string[] {
  // 惰性读 env（确保 config 的 .env 加载已生效）。provider/model 非 secret，作 flag 传。
  // h3：密钥不再走 argv（ps/proc 可见）——pi 从 env 读 PI_API_KEY/GO_API_KEY（见 childEnv 白名单）。
  const provider = process.env.PI_PROVIDER ?? "go";
  const model = process.env.PI_MODEL ?? "deepseek-v4-flash";
  const args = ["-a", "-ne", "-p", "--mode", "json"]; // -p 必须有
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
  for (const s of repoSkillPaths()) args.push("--skill", s); // 自动发现全部 repo skills（ADR-0005）
  for (const e of opts.extensions ?? []) args.push("-e", e);
  for (const a of opts.appendSystemPrompt ?? []) args.push("--append-system-prompt", a); // pi --help 实证（可多次）
  // #37：超长 prompt 走 stdin（pi 实测支持；蒸馏语料可至 MB 级，argv 会 E2BIG）
  if (opts.prompt.length > PROMPT_STDIN_THRESHOLD) return args;
  args.push(opts.prompt); // 位置参数（pi --help 实证：pi -p "…"）
  return args;
}

/** argv prompt 上限（超出走 stdin）。ARG_MAX 含 env ~1MB，512k 留裕量。 */
export const PROMPT_STDIN_THRESHOLD = 512_000;

// h3：pi 子进程 env 白名单——只放行 pi/tavily/系统必需，排除未来 TURN_SECRET/DB 凭据等。
// 注：密钥仍在 pi env 内（pi 需用它鉴权 provider）；彻底不让 pi 见密钥靠 A1 沙箱 + A4 LLM-经服务端代理。
const ENV_NAME_ALLOW = new Set(["PATH", "HOME", "TZ", "TMPDIR", "NODE_PATH", "LANG"]);
// bridge 变量实际经 extraEnv per-turn 注入（见 childEnv 的 extra 合并），不进服务端 process.env，
// 故此条前缀日常匹配不到——保留作 defense-in-depth（spec #11 要求放行；防以后有人把 AGENTANY_BRIDGE_* 设进 env）。
const ENV_PREFIX_ALLOW = [/^PI_/, /^TAVILY_/, /^GO_/, /^LC_/, /^AGENTANY_BRIDGE_/];
// 导出供单测（泄漏收口断言：AGENTANY_DEV_USER 不透传 pi——ADR-0014 债务，step c 收）。
export function childEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_NAME_ALLOW.has(k) || ENV_PREFIX_ALLOW.some((re) => re.test(k))) out[k] = v;
  }
  return { ...out, ...extra }; // extra = per-turn 注入（受信，直接合并，不经白名单筛）
}

// h9：全局 Pi 并发上限（防无界 spawn → 资源/成本 DoS）。溢出队列满则 PiBusy→路由 429。
const PI_CONCURRENCY = Number(process.env.PI_CONCURRENCY ?? 4);
const PI_MAX_WAITERS = Number(process.env.PI_MAX_WAITERS ?? 8);
let piActive = 0;
const piWaiters: Array<() => void> = [];
export class PiBusy extends Error {
  constructor() { super("pi concurrency limit reached"); this.name = "PiBusy"; }
}
function piAcquire(): Promise<void> {
  if (piActive < PI_CONCURRENCY) { piActive++; return Promise.resolve(); }
  if (piWaiters.length >= PI_MAX_WAITERS) throw new PiBusy();
  return new Promise<void>((res) => piWaiters.push(() => { piActive++; res(); }));
}
function piRelease(): void {
  piActive = Math.max(0, piActive - 1);
  const w = piWaiters.shift();
  if (w) w();
}

// 共享 spawn core：缓冲版 runPi 与流式版 runPiStream 同一路径，只差 onDelta/onBlock 回调（ADR-0009 BE-Q3；#20）。
async function spawnPiCore(opts: RunPiStreamOptions): Promise<RunPiResult> {
  const cwd = opts.cwd ?? process.cwd();
  mkdirSync(cwd, { recursive: true });

  const piBin = process.env.PI_BIN ?? "pi";
  // A1 沙箱（ticket #2）：把 pi 子进程包进 OS 沙箱——仅工作区+sessions 可写、skills 只读、
  // 其余（.env/DB/源码/家目录/其它项目）不可达、网络全禁。逃生阀 AGENTANY_NO_SANDBOX=1 直通。
  // 扩展父目录加入 ro：pi 经 -e 加载的扩展（含其同侧 import，如 chat-bridge→bridge-core）需可读。
  // skills/ 下扩展已被 repoSkillsDir() 覆盖；chat/extensions/ 等非 skills 扩展靠此处放行（ticket #12）。
  const extDirs = Array.from(new Set((opts.extensions ?? []).map(dirname)));
  const plan = wrapSpawn({
    argv: [piBin, ...buildArgs(opts)],
    cwd,
    env: childEnv(opts.extraEnv),
    net: "deny",
    loopbackPorts: opts.loopbackPorts,
    allow: {
      rw: [cwd, opts.sessionDir].filter((p): p is string => !!p),
      ro: [repoSkillsDir(), ...extDirs],
    },
  });
  const proc = spawn(plan.argv[0], plan.argv.slice(1), {
    cwd: plan.cwd,
    stdio: ["pipe", "pipe", "pipe"], // #37 stdin 通道：超长 prompt 写入（短 prompt 仍走 argv，立即 end）
    env: plan.env,
  });
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  if (!stdout || !stderr) throw new Error("spawn failed: no stdio");
  // #37 超长 prompt 走 stdin（buildArgs 已不进 argv）；写完即 end——pi 读 EOF 后当 prompt 处理
  if (opts.prompt.length > PROMPT_STDIN_THRESHOLD) proc.stdin.write(opts.prompt);
  proc.stdin.end();

  return new Promise<RunPiResult>((resolveP, reject) => {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(`runPi timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    let textBuf = "";
    let messages: unknown[] = [];
    let toolResults: unknown[] = [];
    let errBuf = "";
    const dec = new StringDecoder("utf8");
    let buf = "";
    const emitBlocks = createBlockEmitter(); // #20：事件→三帧（无 onBlock 时也计算无害，事件量小）

    const onLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      // f3/ADR-0019：block 三帧是唯一增量通道（legacy onDelta 已删）
      if (process.env.AGENTANY_DEBUG_BLOCKS) console.error("[dbg-blocks] ev:", JSON.stringify(ev).slice(0, 300));
      if (opts.onBlock) for (const b of emitBlocks(ev)) opts.onBlock(b);
      switch (ev.type) {
        case "message_update": {
          const d = ev.assistantMessageEvent;
          if (d && d.type === "text_delta") textBuf += d.delta ?? ""; // 攒全文只供 RunPiResult.text（非流）
          break;
        }
        case "turn_end":
          toolResults = ev.toolResults ?? [];
          break;
        case "agent_end":
          messages = ev.messages ?? [];
          break;
      }
    };

    stdout.on("data", (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : dec.write(chunk);
      // 手写 LF 切分 reader（readline 在 U+2028/2029 误断，见 learnings/pi-headless-extension-ui-handshake.md）
      while (true) {
        const i = buf.indexOf("\n");
        if (i === -1) break;
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        onLine(line);
      }
    });

    stderr.on("data", (c: Buffer | string) => { errBuf += typeof c === "string" ? c : c.toString("utf8"); });

    const finish = (err?: Error) => {
      clearTimeout(timer);
      if (err) { reject(err); return; }
      let text = textBuf;
      if (!text && messages.length) {
        // 权威文本：agent_end.messages 最后一个 assistant 的 text 块
        const asst = [...messages].reverse().find((m: any) => m.role === "assistant") as any;
        if (asst) {
          text = (asst.content || [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
        }
      }
      resolveP({ text, messages, toolResults, sessionId: opts.sessionId });
    };

    proc.on("error", (e) => finish(e));
    proc.on("close", (code) => {
      if (buf.trim()) onLine(buf); // 残行
      if (code !== 0) finish(new Error(`pi exit code ${code}${errBuf ? `: ${errBuf.slice(0, 500)}` : ""}`));
      else finish();
    });

    opts.signal?.addEventListener("abort", () => {
      try { proc.kill("SIGKILL"); } catch {}
    });
  });
}

// h9：并发信号量包装——保证 acquire/release 配对（finally 释放）。两壳同过信号量。
export async function runPi(opts: RunPiOptions): Promise<RunPiResult> {
  await piAcquire();
  try {
    return await spawnPiCore(opts);
  } finally {
    piRelease();
  }
}

// 流式壳（chat 用）：多 onDelta/onBlock；复用 spawnPiCore，行为与 runPi 一致（含 signal/timeout）。
export async function runPiStream(opts: RunPiStreamOptions): Promise<RunPiResult> {
  await piAcquire();
  try {
    return await spawnPiCore(opts);
  } finally {
    piRelease();
  }
}
