// Spike A · 步骤3 — rpc 并发：流式中再发 prompt（朴素 vs followUp）
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const PI = "/Users/max/.nvm/versions/node/v24.13.1/bin/pi";
const SPIKE_DIR = "/Volumes/SN350-1T/dev/agentany/spikes/spike-a";
const keyArg = process.env.GO_API_KEY
  ? ["--provider", "go", "--model", "deepseek-v4-flash", "--api-key", process.env.GO_API_KEY]
  : [];
const proc = spawn(PI, ["-a", "-ne", "--mode", "rpc", "--no-session", ...keyArg], {
  cwd: SPIKE_DIR, stdio: ["pipe", "pipe", "inherit"],
});

const dialogMethods = new Set(["select", "confirm", "input", "editor"]);
const responses = [];
let done = false; const started = Date.now();
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");

function onLine(line) {
  if (!line.trim()) return;
  let ev; try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === "extension_ui_request" && dialogMethods.has(ev.method)) {
    send(ev.method === "confirm"
      ? { type: "extension_ui_response", id: ev.id, confirmed: false }
      : { type: "extension_ui_response", id: ev.id, cancelled: true });
  }
  if (ev.type === "response") responses.push({ id: ev.id, cmd: ev.command, success: ev.success, error: ev.error });
  if (ev.type === "agent_settled") finish("settled");
}
const dec = new StringDecoder("utf8"); let buf = "";
proc.stdout.on("data", (c) => {
  buf += typeof c === "string" ? c : dec.write(c);
  while (true) { const i = buf.indexOf("\n"); if (i === -1) break; let l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.endsWith("\r")) l = l.slice(0, -1); onLine(l); }
});
proc.on("exit", (c, s) => { if (!done) finish("exit", `code=${c} sig=${s}`); });

function finish(reason, extra) {
  if (done) return; done = true;
  console.log("\n=== CONCURRENCY RESULT ===");
  console.log("reason:", reason, extra || "", "elapsed_ms:", Date.now() - started);
  console.log("responses:", JSON.stringify(responses));
  console.log('判读: p2 朴素(流式中)应 success:false(error: already streaming); p3 followUp 应 success:true(排队)');
  try { proc.kill("SIGKILL"); } catch {}
  process.exit(0);
}
setTimeout(() => { if (!done) finish("TIMEOUT", "60s"); }, 60000);

// p1：长任务，确保 t=3.5s 时仍在流式
setTimeout(() => { console.log(">> p1"); send({ id: "p1", type: "prompt", message: "Count slowly from 1 to 40, one number per line. Take your time." }); }, 1200);
// p2：朴素，流式中再发 → 预期 error
setTimeout(() => { console.log(">> p2 (naive)"); send({ id: "p2", type: "prompt", message: "Say BANANA." }); }, 3500);
// p3：followUp → 预期 accepted/排队
setTimeout(() => { console.log(">> p3 (followUp)"); send({ id: "p3", type: "prompt", message: "Then say CHERRY.", streamingBehavior: "followUp" }); }, 5000);
