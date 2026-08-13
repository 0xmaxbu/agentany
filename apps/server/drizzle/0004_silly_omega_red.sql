PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_runs` (
	`runId` text PRIMARY KEY NOT NULL,
	`workflowId` text NOT NULL,
	`projectId` text,
	`conversationId` text,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_workflow_runs`("runId", "workflowId", "projectId", "status", "input", "createdAt", "updatedAt") SELECT "runId", "workflowId", "projectId", "status", "input", "createdAt", "updatedAt" FROM `workflow_runs`;--> statement-breakpoint
DROP TABLE `workflow_runs`;--> statement-breakpoint
ALTER TABLE `__new_workflow_runs` RENAME TO `workflow_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;