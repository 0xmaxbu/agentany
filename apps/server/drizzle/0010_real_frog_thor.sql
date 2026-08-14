DROP TABLE `project_members`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `conversations` DROP COLUMN `projectId`;--> statement-breakpoint
ALTER TABLE `workflow_runs` DROP COLUMN `projectId`;