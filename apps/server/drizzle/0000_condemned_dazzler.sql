CREATE TABLE `workflow_run_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`runId` text NOT NULL,
	`seq` integer NOT NULL,
	`stepId` text NOT NULL,
	`status` text NOT NULL,
	`input` text,
	`output` text,
	`suspendPayload` text,
	`resumeSchema` text,
	`resumeData` text,
	`ts` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`runId` text PRIMARY KEY NOT NULL,
	`workflowId` text NOT NULL,
	`projectId` text NOT NULL,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
