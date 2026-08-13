// Spike A · 步骤5 — WORKDIR 清洗器：扫出 realpath 逃出树的条目（symlink→外）
// 注意：hardlink 的 realpath 不逃出（它就是该文件），realpath 检测不到 → 靠沙箱挡（已记）
import { readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const WD = process.argv[2] || "/Volumes/SN350-1T/dev/agentany/spikes/spike-a/sandbox-wd/work";
const root = resolve(WD);
const underRoot = (p) => p === root || p.startsWith(root + sep);
const bad = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      let rp; try { rp = realpathSync(p); } catch { bad.push({ path: p, kind: "symlink-broken" }); continue; }
      if (!underRoot(rp)) bad.push({ path: p, kind: "symlink-escape", target: rp });
      continue;
    }
    if (st.isDirectory()) walk(p);
  }
}
walk(root);
console.log("=== SANITIZER RESULT ===");
console.log("workdir:", root);
console.log("escaping entries:", bad.length);
for (const b of bad) console.log("  ✗", b.kind, pshort(b.path), "->", b.target || "");
console.log(bad.length === 0 ? "✓ clean (可启动)" : "✗ 拒绝启动（清洗未过）");
function pshort(p) { return p.replace(root + "/", ""); }
