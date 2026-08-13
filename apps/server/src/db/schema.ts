// Drizzle schema：对齐 Spike B 的 append-only 执行日志两表（ADR-0004/0007）。
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const workflowRuns = sqliteTable("workflow_runs", {
  runId: text("runId").primaryKey(),
  workflowId: text("workflowId").notNull(),
  projectId: text("projectId"), // 可空：general 会话起的 run 无 project（ticket #14）
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
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  projectId: text("projectId"), // 可空：null = general（无项目）会话（ADR-0009 / ticket #10）
  userId: text("userId").notNull(), // dev 桩 = dev-user；真 auth 后由 session 派生
  title: text("title"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

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
