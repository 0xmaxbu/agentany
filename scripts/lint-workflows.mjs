// scripts/lint-workflows.mjs — 校验 coded 工作流 ↔ 规格 md 一一成对（Q5）。
//   - coded (.ts) 无对应 spec (.md) → 报错（源真相必须有规格）
//   - spec (.md) 无对应 code (.ts) 且不在 PENDING → 报错
// 内容是 prose，靠人维护，本脚本只查成对存在。
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const CODE_DIR = join(ROOT, "apps/server/src/workflows");
const SPEC_DIR = join(ROOT, "workflows");

// 已有 Pi-prose 规格、尚未 coded 的迁移样本（迁移完即从此移除）。
const PENDING_MIGRATION = new Set([]);

const code = readdirSync(CODE_DIR).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, ""));
const spec = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.replace(/\.md$/, ""));

const missingSpec = code.filter((id) => !spec.includes(id));
const missingCode = spec.filter((id) => !code.includes(id) && !PENDING_MIGRATION.has(id));

let ok = true;
for (const id of missingSpec) { console.error(`✗ coded "${id}" 缺规格 workflows/${id}.md`); ok = false; }
for (const id of missingCode) { console.error(`✗ 规格 workflows/${id}.md 无对应 coded apps/server/src/workflows/${id}.ts`); ok = false; }
for (const id of spec.filter((id) => PENDING_MIGRATION.has(id))) { console.log(`· ${id}：待迁移（PENDING_MIGRATION）`); }

if (ok) console.log(`✓ ${code.length} 个 coded 工作流全部 spec↔code 成对`);
process.exit(ok ? 0 : 1);
