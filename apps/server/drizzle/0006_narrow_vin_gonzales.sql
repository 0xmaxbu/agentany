PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hitl_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversationId` text NOT NULL,
	`runId` text,
	`kind` text DEFAULT 'ask' NOT NULL,
	`workflowId` text,
	`input` text,
	`prompt` text NOT NULL,
	`options` text NOT NULL,
	`resumeSchema` text,
	`multiple` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer` text,
	`decidedBy` text,
	`createdAt` text NOT NULL,
	`answeredAt` text
);
--> statement-breakpoint
-- [手修 #18] drizzle-kit 产出的 INSERT SELECT 对新增列写的是 `"kind" "workflowId" "input" "decidedBy"`，
-- 但旧表无这些列——SQLite 的「双引号字符串字面量」怪癖会把它们当成字面量 'kind'/'workflowId'/... 填入，
-- 导致旧行 kind='kind'（非 'ask'），被 turn.ts:40 的 kind:'ask' 过滤静默丢弃。改为显式字面量 'ask' + NULL。
INSERT INTO `__new_hitl_questions`("id", "conversationId", "runId", "kind", "workflowId", "input", "prompt", "options", "resumeSchema", "multiple", "status", "answer", "decidedBy", "createdAt", "answeredAt") SELECT "id", "conversationId", "runId", 'ask', NULL, NULL, "prompt", "options", "resumeSchema", "multiple", "status", "answer", NULL, "createdAt", "answeredAt" FROM `hitl_questions`;--> statement-breakpoint
DROP TABLE `hitl_questions`;--> statement-breakpoint
ALTER TABLE `__new_hitl_questions` RENAME TO `hitl_questions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;