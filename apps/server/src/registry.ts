// 组合根·注册表：boot 时静态 import map（Q2）。engine 不 import 这里；routes/runs 从这取。
import type { Workflow } from "./workflow-engine/defineWorkflow";
import { synthetic } from "./workflows/synthetic";
import { brandResearch } from "./workflows/brand-research";
import { brandStrategyAnalysis } from "./workflows/brand-strategy-analysis";
import { deviceAcceptance } from "./workflows/device-acceptance";

const ALL: Workflow[] = [synthetic, brandResearch, brandStrategyAnalysis, deviceAcceptance];
const byId = new Map<string, Workflow>(ALL.map((w) => [w.id, w]));

export function getWorkflow(id: string): Workflow | undefined {
  return byId.get(id);
}

export function listWorkflows(): { id: string; name?: string; description?: string; inputSchema?: unknown }[] {
  return ALL.map((w) => ({ id: w.id, name: w.name, description: w.description, inputSchema: w.inputSchema }));
}
