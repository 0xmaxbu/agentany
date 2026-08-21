// 全局工具注册表（ADR-0033/R-1 决策 3）：{name, argsSchema, remote} 单一真相。
// 供 R-3/R-4 preflight 的 remote 判定、R-5 pi stub 生成查询。argsSchema 用本仓**可序列化** schema.ts 原语
// （不引 zod/TypeBox——那是 pi 侧筛查；TypeBox 桥接归 R-5）。registry 全局态惯例同 ../registry.ts
// （workflow 注册表 boot 静态 import map；测试按需不动它）。
import type { Schema } from "@agentany/ws-protocol"; // ADR-0034 D2：argsSchema 随 tool_call 下发设备，类型真相在协议包
import { schema, validate } from "@agentany/ws-protocol";

export interface ToolDef {
  name: string;
  argsSchema: Schema;
  remote: boolean; // false=服务器本地执行（现状）；true=远端设备执行（R-5 起引入）
}

const registry = new Map<string, ToolDef>();

/** 注册（boot 期静态调用；重名抛——单一真相不静默覆盖）。 */
export function registerTool(def: ToolDef): void {
  if (registry.has(def.name)) throw new Error(`tool already registered: ${def.name}`);
  registry.set(def.name, def);
}

/** 按名解析；未注册返回 undefined。 */
export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

/** 全量枚举（R-5 stub 生成的候选集）。 */
export function listTools(): ToolDef[] {
  return [...registry.values()];
}

/** R-5 复用：参数校验与本地工具行为一致（schema 原语 validate）。 */
export function validateToolArgs(name: string, args: unknown): { ok: true } | { ok: false; error: string } {
  const t = registry.get(name);
  if (!t) return { ok: false, error: `unknown tool: ${name}` };
  return validate(t.argsSchema, args);
}

// —— 初始种子：现状真实被工作流/chat 调用的工具（tavily 三件套，本地执行）。——
// web_search / web_extract / web_crawl 的 TypeBox 参数形状→可序列化 schema（与 tavily-search 扩展一致）。
registerTool({
  name: "web_search",
  argsSchema: schema.object({
    query: schema.string(),
    max_results: schema.optional(schema.number()),
    search_depth: schema.optional(schema.enum("basic", "advanced")),
  }),
  remote: false,
});
registerTool({
  name: "web_extract",
  argsSchema: schema.object({
    urls: schema.array(schema.string()),
  }),
  remote: false,
});
registerTool({
  name: "web_crawl",
  argsSchema: schema.object({
    url: schema.string(),
    max_depth: schema.optional(schema.number()),
    limit: schema.optional(schema.number()),
  }),
  remote: false,
});

// ADR-0033/R-3（#75）：首个 remote 占位工具——语义=「服务器注定跑不成的设备侧命令」（GPU/windows 桌面类）。
// 当前惰性（无 stub/转发，R-5 接 tool_call 通道）；预检已能据 remote:true 判定设备在线（R-3 设备门测试载体）。
registerTool({
  name: "device_shell",
  argsSchema: schema.object({
    command: schema.string(),
    cwd: schema.optional(schema.string()),
    timeoutMs: schema.optional(schema.number()),
  }),
  remote: true,
});

// ADR-0036 / R-6 P2（agentany-client issue #3）：五执行器各独立注册（remote:true + argsSchema）。
// 设备侧同名 handler 在 agentany-client/apps/client-core（defaultExecutors）；argsSchema 随 tool_call 下发。
// bash 语义与 device_shell 重叠——保留占位（r3 预检测试载体），五件套从 bash 开始。
registerTool({
  name: "bash",
  argsSchema: schema.object({
    command: schema.string(),
    cwd: schema.optional(schema.string()),
    timeoutMs: schema.optional(schema.number()),
  }),
  remote: true,
});
registerTool({
  name: "write",
  argsSchema: schema.object({
    path: schema.string(),
    content: schema.string(),
  }),
  remote: true,
});
registerTool({
  name: "read",
  argsSchema: schema.object({
    path: schema.string(),
    offset: schema.optional(schema.number()),
    limit: schema.optional(schema.number()),
  }),
  remote: true,
});
registerTool({
  name: "grep",
  argsSchema: schema.object({
    pattern: schema.string(),
    path: schema.optional(schema.string()),
  }),
  remote: true,
});
registerTool({
  name: "edit",
  argsSchema: schema.object({
    path: schema.string(),
    old: schema.string(),
    new: schema.string(),
  }),
  remote: true,
});

// ADR-0036 / R-6 P3（agentany-client issue #4）：computer-use 三件套（macOS 原生桥 screens/observe/act）。
// 机械语义：screens 无参；observe 截图+可选 AX outline；act 原子动作（ref AX 语义优先 / x,y 图像像素兜底）。
// argsSchema 与 agentany-client/apps/client-core/src/computer-use.ts 执行器解析对齐。
registerTool({
  name: "computer_use.screens",
  argsSchema: schema.object({}),
  remote: true,
});
registerTool({
  name: "computer_use.observe",
  argsSchema: schema.object({
    mode: schema.optional(schema.enum("visual", "visual+ax")),
    display_id: schema.optional(schema.string()),
    window_id: schema.optional(schema.number()),
    max_long_edge: schema.optional(schema.number()),
  }),
  remote: true,
});
registerTool({
  name: "computer_use.act",
  argsSchema: schema.object({
    action: schema.object({
      type: schema.enum("move", "click", "dblclick", "rightclick", "drag", "scroll", "type", "hotkey", "wait"),
      button: schema.optional(schema.enum("left", "right", "middle")),
      text: schema.optional(schema.string()),
      keys: schema.optional(schema.array(schema.string())),
      ms: schema.optional(schema.number()),
      dx: schema.optional(schema.number()),
      dy: schema.optional(schema.number()),
    }),
    ref: schema.optional(schema.string()),
    x: schema.optional(schema.number()),
    y: schema.optional(schema.number()),
    window_id: schema.optional(schema.number()),
    display_id: schema.optional(schema.string()),
    state_id: schema.optional(schema.number()),
    max_long_edge: schema.optional(schema.number()),
  }),
  remote: true,
});

// ADR-0035（2026-08-21 修订）/ R-6 P4（agentany-client issue #5）：browser 六件套——统一 ChromeBackend
// （客户端自启 Chrome/Edge + 专用持久 profile；ego 暂缓）。机械语义：tabs 列/建/关/聚焦；
// navigate 等 loadEventFired；click x,y 视口像素（先发插值 move 轨迹）；type 逐字符键入；
// evaluate 隔离世界 JS；screenshot 页面视口 JPEG。argsSchema 与 client-core/src/browser/executors.ts 对齐。
registerTool({
  name: "browser.tabs",
  argsSchema: schema.object({
    action: schema.optional(schema.enum("list", "new", "close", "activate")),
    tab_id: schema.optional(schema.string()),
    url: schema.optional(schema.string()),
  }),
  remote: true,
});
registerTool({
  name: "browser.navigate",
  argsSchema: schema.object({
    url: schema.string(),
    tab_id: schema.optional(schema.string()),
  }),
  remote: true,
});
registerTool({
  name: "browser.click",
  argsSchema: schema.object({
    x: schema.number(),
    y: schema.number(),
    button: schema.optional(schema.enum("left", "right", "middle")),
    tab_id: schema.optional(schema.string()),
  }),
  remote: true,
});
registerTool({
  name: "browser.type",
  argsSchema: schema.object({
    text: schema.string(),
    tab_id: schema.optional(schema.string()),
  }),
  remote: true,
});
registerTool({
  name: "browser.evaluate",
  argsSchema: schema.object({
    expression: schema.string(),
    tab_id: schema.optional(schema.string()),
  }),
  remote: true,
});
registerTool({
  name: "browser.screenshot",
  argsSchema: schema.object({
    tab_id: schema.optional(schema.string()),
    quality: schema.optional(schema.number()),
  }),
  remote: true,
});