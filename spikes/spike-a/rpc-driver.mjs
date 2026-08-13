// Spike A · 步骤2 — Pi RPC 驱动原型（手写 JSONL reader + UI 应答器 + 超时）
// 证明：能无头驱动 pi --mode rpc、解析事件流、兜底应答 UI 请求、不卡死。
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const PI = "/Users/max/.nvm/versions/node/v24.13.1/bin/pi";
const SPIKE_DIR = "/Volumes/SN350-1T/dev/agentany/spikes/spike-a";
const TIMEOUT_MS = 60000;

const keyArg = process.env.GO_API_KEY
  ? ["--provider", "go", "--model", "deepseek-v4-flash", "--api-key", process.env.GO_API_KEY]
  : [];
const proc = spawn(PI, ["-a", "-ne", "--mode", "rpc", "--no-session", ...keyArg], {
  cwd: SPIKE_DIR, // 工作区 cwd（沙箱用）；key 走环境变量注入，不依赖 .env-at-cwd
  stdio: ["pipe", "pipe", "inherit"],
});

const dialogMethods = new Set(["select", "confirm", "input", "editor"]);
let textBuf = "";
const uiRequests = [];
const eventCounts = {};
let turnEnd = null, agentEnd = null, sawDelta = false;
const started = Date.now();
let done = false;

const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");

function handleUiRequest(req) {
  uiRequests.push({ method: req.method, dialog: dialogMethods.has(req.method) });
  if (dialogMethods.has(req.method)) {
    // 安全默认：deny/cancel
    const resp = { type: "extension_ui_response", id: req.id };
    if (req.method === "confirm") resp.confirmed = false; else resp.cancelled = true;
    send(resp);
  }
  // fire-and-forget（notify/setTitle/setStatus/setWidget/set_editor_text）：无需应答
}

function onLine(line) {
  if (!line.trim()) return;
  let ev;
  try { ev = JSON.parse(line); } catch { console.error("PARSE_ERR:", line.slice(0, 160)); return; }
  eventCounts[ev.type] = (eventCounts[ev.type] || 0) + 1;
  switch (ev.type) {
    case "extension_ui_request": handleUiRequest(ev); break;
    case "message_update": {
      const d = ev.assistantMessageEvent;
      if (d && d.type === "text_delta") { textBuf += d.delta; sawDelta = true; }
      break;
    }
    case "turn_end": turnEnd = ev; break;
    case "agent_end": {
      agentEnd = ev;
      // 权威文本从最终 messages 取（流式 delta 可能不发——本次 DeepSeek/rpc 就没发）
      const asst = [...(ev.messages || [])].reverse().find((m) => m.role === "assistant");
      if (asst) {
        const t = (asst.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
        if (t && !textBuf) textBuf = t;
      }
      break;
    }
    case "agent_settled": finish("settled"); break;
    case "response": if (ev.success === false) console.log("CMD_ERR:", ev.command, ev.error); break;
  }
}

// 手写 JSONL reader（按 LF 切分；readline 会在 U+2028/2029 误断，不可用——见 rpc.md）
const dec = new StringDecoder("utf8");
let buf = "";
proc.stdout.on("data", (chunk) => {
  buf += typeof chunk === "string" ? chunk : dec.write(chunk);
  while (true) {
    const i = buf.indexOf("\n");
    if (i === -1) break;
    let line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    onLine(line);
  }
});
proc.on("exit", (c, s) => { if (!done) finish("exit", `code=${c} sig=${s}`); });

function finish(reason, extra) {
  if (done) return; done = true;
  console.log("\n=== RPC DRIVER RESULT ===");
  console.log("reason:", reason, extra || "");
  console.log("elapsed_ms:", Date.now() - started);
  console.log("extracted_text:", JSON.stringify(textBuf));
  console.log("saw_streaming_delta:", sawDelta);
  console.log("event_counts:", JSON.stringify(eventCounts));
  console.log("ui_requests:", JSON.stringify(uiRequests));
  console.log("turn_end_toolResults:", turnEnd ? (turnEnd.toolResults?.length ?? 0) : "none");
  console.log("agent_end_messages:", agentEnd ? agentEnd.messages?.length : "none");
  if (agentEnd) {
    for (const m of agentEnd.messages || []) {
      const ct = Array.isArray(m.content) ? m.content.map((c) => c.type).join(",") : typeof m.content;
      console.log(`  msg[${m.role}] content=[${ct}]`);
    }
    const a = [...(agentEnd.messages || [])].reverse().find((m) => m.role === "assistant");
    if (a) console.log("  assistant_raw:", JSON.stringify(a).slice(0, 500));
  }
  try { proc.kill("SIGKILL"); } catch {}
  process.exit(0);
}

setTimeout(() => { if (!done) finish("TIMEOUT/HANG", `no agent_settled within ${TIMEOUT_MS}ms`); }, TIMEOUT_MS);
const PROMPT = process.argv[2] || "Reply with exactly the word PONG and nothing else.";
setTimeout(() => { console.log("sending prompt:", PROMPT); send({ id: "p1", type: "prompt", message: PROMPT }); }, 1500);
