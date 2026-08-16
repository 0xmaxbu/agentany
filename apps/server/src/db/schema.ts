// Drizzle schema：对齐 Spike B 的 append-only 执行日志两表（ADR-0004/0007）。
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workflowRuns = sqliteTable("workflow_runs", {
  runId: text("runId").primaryKey(),
  workflowId: text("workflowId").notNull(),
  workspaceId: text("workspaceId").notNull().default("ws_company"), // ADR-0018：run 挂 workspace；缺省公司 ws
  conversationId: text("conversationId"), // chat 起的 run 绑会话（事件推回该会话流；ticket #14）
  status: text("status").notNull(), // running|suspended|completed|failed
  input: text("input").notNull(), // JSON
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const workflowRunLog = sqliteTable("workflow_run_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("runId").notNull(),
  seq: integer("seq").notNull(), // per-run 单调
  stepId: text("stepId").notNull(),
  status: text("status").notNull(), // running|completed|suspended|failed
  input: text("input"), // JSON：该步被调用时的输入（suspend 续跑重执行要用）
  output: text("output"), // JSON：该步产出（completed）
  suspendPayload: text("suspendPayload"), // JSON
  resumeSchema: text("resumeSchema"), // JSON：续跑数据契约（纯数据 schema，可序列化）
  resumeData: text("resumeData"), // JSON：实际续跑数据
  ts: text("ts").notNull(),
});

// 反馈（ADR-0008 持续学习闭环）：多态挂载到任意「执行」。
export const feedback = sqliteTable("feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  targetKind: text("targetKind").notNull(), // workflow_run | chat | …
  targetId: text("targetId").notNull(), // runId / conversationId / …
  text: text("text").notNull(),
  rating: integer("rating"), // 可选 1-5
  createdAt: text("createdAt").notNull(),
});

// chat 切片①（ADR-0009）：会话 = 一条持久 Pi session（chat-<conversationId>）。
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull().default("ws_company"), // ADR-0018：会话挂 workspace；缺省公司 ws
    userId: text("userId").notNull(), // 创建者（会话一律创建者私有，ADR-0018）
    title: text("title"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
    archivedAt: text("archivedAt"), // #21/ADR-0020：null=活跃；非空=归档（只读可恢复）。软态真相源
  },
  (t) => ({
    // #手风琴：ws 活跃度聚合（WHERE userId+archivedAt → GROUP BY workspaceId → max(updatedAt)）覆盖索引，免全表扫
    userWsActive: index("conversations_user_ws_active_idx").on(t.userId, t.archivedAt, t.workspaceId, t.updatedAt),
  }),
);

// 会话消息：user 进来即落库；assistant turn 干净结束一次性落库。
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversationId").notNull(),
  role: text("role").notNull(), // user | assistant
  content: text("content").notNull(),
  attachments: text("attachments"), // JSON
  createdAt: text("createdAt").notNull(),
});

// HITL 提问（ticket #16 ask_user + #18 审批门）：ask_user 工具异步建 pending question；用户答→resume→markAnswered。
// 多通道（chat 卡 / IM 文本）同表；判答融入 chat pi turn（pending 每轮注入 --append-system-prompt）。
// #18 复用本表做审批载体：kind=approval（runId 可空——审批通过前未建 run）。
export const hitlQuestions = sqliteTable("hitl_questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversationId").notNull(),
  runId: text("runId"), // 绑定挂起的 run；#18 approval 卡通过前无 run → 可空
  kind: text("kind").notNull().default("ask"), // ask（#16 HITL）| approval（#18 审批门）；旧行默认 ask
  workflowId: text("workflowId"), // #18 approval：待审批的工作流（ask 卡为空）
  input: text("input"), // #18 approval：待审批的 input（JSON）—— approve 后用它 createRun
  prompt: text("prompt").notNull(),
  options: text("options").notNull(), // JSON string[]
  resumeSchema: text("resumeSchema"), // JSON 手搓可序列化 schema（schema.ts，非 zod；pi/前端可读 enum vals 当候选）
  multiple: integer("multiple").default(0).notNull(), // 0/1（v1 只单选）
  status: text("status").notNull().default("pending"), // pending | answered
  answer: text("answer"), // JSON resumeData（ask：pi 归一化答案；approval：{decision:'approve'|'deny'}）
  decidedBy: text("decidedBy"), // #18 approval：审批人 userId（ask 卡为空）
  createdAt: text("createdAt").notNull(),
  answeredAt: text("answeredAt"),
});

// 用户（真 auth；ADR-0014）。dev-user 为虚拟行（逃生阀派生，不落表）。
export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // "u_" + crypto.randomUUID()
  username: text("username").notNull().unique(), // UNIQUE → 重名抛 SQLITE_CONSTRAINT → 409
  passwordHash: text("passwordHash").notNull(), // argon2id（Bun.password）
  displayName: text("displayName"),
  role: text("role").notNull().default("member"), // admin | member（全局管理员；项目角色另表，步骤 c）
  status: text("status").notNull().default("active"), // active | deactivated（注销=停用）
  createdAt: text("createdAt").notNull(),
});

// opaque token（ADR-0014）：落库存 sha256(token)（非明文）；注销/改密/重置=删行；强断已开 SSE 走 StreamRegistry。
export const authTokens = sqliteTable("auth_tokens", {
  tokenHash: text("tokenHash").primaryKey(), // sha256(明文 token)
  userId: text("userId").notNull(),
  createdAt: text("createdAt").notNull(),
});

// 工作空间（ADR-0018）：可访问目录 + 权限控制的唯一原子单位。无 type——权限只有 allUsers ∪ 名单两种表达。
// 公司 ws 固定 id "ws_company"（迁移 seed）；目录锚：ws_company→data/general，其余→data/workspaces/<id>。
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(), // "ws_" + crypto.randomUUID()；公司级固定 "ws_company"
  slug: text("slug").notNull().unique(), // 人类可读、URL 友好、唯一
  name: text("name").notNull(),
  allUsers: integer("allUsers", { mode: "boolean" }).notNull().default(false), // true=全体在职用户可访
  status: text("status").notNull().default("active"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
  archivedAt: text("archivedAt"), // #手风琴：null=活跃；admin 可归档（侧栏隐藏，会话可看可发）
});

// 工作空间可访问名单（ADR-0018）。读时 join users 过滤 active（注销用户悬空行留作审计，不清理）。
export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspaceId").notNull(),
    userId: text("userId").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (t) => ({
    // SQLiteTableExtraConfig = Record<string,…>（对象形式，非数组）；防重复加成员
    wsUid: uniqueIndex("workspace_members_workspaceId_userId_unique").on(t.workspaceId, t.userId),
  }),
);

// 定时任务（#25/ADR-0021）：cron 触发的自由 prompt LLM 任务（不触发工作流）。
// 两类 scope：workspace（成员自建，绑建时 ws+产出会话）/ system（跨 ws 内置如蒸馏，seed DB 行，无产出会话）。
export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey(), // "t_" + uuid
    scope: text("scope").notNull(), // workspace | system
    workspaceId: text("workspaceId"), // system 时 null
    displayName: text("displayName").notNull(),
    cron: text("cron").notNull(), // 5 段标准 cron
    prompt: text("prompt").notNull(),
    outputConversationId: text("outputConversationId"), // workspace 时必填；system null
    creatorId: text("creatorId").notNull(),
    nextFireAt: text("nextFireAt").notNull(), // ISO——调度扫描键
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("createdAt").notNull(),
  },
  (t) => ({
    // dueTasks 扫描：enabled AND nextFireAt（索引覆盖 WHERE + ORDER BY）
    due: index("scheduled_tasks_enabled_nextFireAt_idx").on(t.enabled, t.nextFireAt),
  }),
);

// 任务执行历史（#25/ADR-0021 决策 8）：viewedAt null=未读（system 任务 badge 计数锚）。
export const taskRuns = sqliteTable(
  "task_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("taskId").notNull(),
    trigger: text("trigger").notNull(), // cron | manual（手动不推进 nextFireAt）
    status: text("status").notNull(), // ok | failed | missed | skipped_overrun
    startedAt: text("startedAt"), // missed/skipped 无实际开始
    finishedAt: text("finishedAt"),
    outputMessageId: text("outputMessageId"), // 产出消息引用（可悬空——消息表自增 id）
    viewedAt: text("viewedAt"), // null=未读
  },
  (t) => ({
    taskViewed: index("task_runs_taskId_id_idx").on(t.taskId, t.id),
  }),
);

// 任务产出文件（#25 一次定型 schema；切片 3 写入）：ws 相对路径防逃逸。
export const taskFiles = sqliteTable(
  "task_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskRunId: text("taskRunId").notNull(),
    path: text("path").notNull(), // workspace 内相对路径
    name: text("name").notNull(), // 下载显示名
    createdAt: text("createdAt").notNull(),
  },
  (t) => ({
    run: index("task_files_taskRunId_idx").on(t.taskRunId),
  }),
);
