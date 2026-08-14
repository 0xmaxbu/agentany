CREATE TABLE `workspace_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspaceId` text NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_workspaceId_userId_unique` ON `workspace_members` (`workspaceId`,`userId`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`allUsers` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `workspaceId` text DEFAULT 'ws_company' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `workspaceId` text DEFAULT 'ws_company' NOT NULL;--> statement-breakpoint
--> seed（ADR-0018）：默认公司 workspace，固定 id。幂等：所有库（含测试 :memory:）天然具备，零 bootstrap 代码。
INSERT OR IGNORE INTO `workspaces` (`id`,`slug`,`name`,`allUsers`,`status`,`createdAt`,`updatedAt`)
VALUES ('ws_company','company','公司',1,'active','2026-08-14T00:00:00.000Z','2026-08-14T00:00:00.000Z');
