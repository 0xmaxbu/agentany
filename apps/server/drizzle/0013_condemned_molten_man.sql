CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`workspaceId` text,
	`displayName` text NOT NULL,
	`cron` text NOT NULL,
	`prompt` text NOT NULL,
	`outputConversationId` text,
	`creatorId` text NOT NULL,
	`nextFireAt` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_tasks_enabled_nextFireAt_idx` ON `scheduled_tasks` (`enabled`,`nextFireAt`);--> statement-breakpoint
CREATE TABLE `task_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`taskRunId` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_files_taskRunId_idx` ON `task_files` (`taskRunId`);--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`taskId` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`startedAt` text,
	`finishedAt` text,
	`outputMessageId` text,
	`viewedAt` text
);
--> statement-breakpoint
CREATE INDEX `task_runs_taskId_id_idx` ON `task_runs` (`taskId`,`id`);--> statement-breakpoint
--> seed（#25/ADR-0021）：经验蒸馏 system 任务（M5 蒸馏的调度载体；prompt 为占位，切片 5 装配真链）。
--> 幂等（固定 id INSERT OR IGNORE）：所有库含测试 :memory: 天然具备；nextFireAt 由代码侧启动时惰性补算
--> （迁移内不掺 Date.now——SQL 静态值跨时区漂移）。cron=每周日 04:00。
INSERT OR IGNORE INTO `scheduled_tasks`
  (`id`,`scope`,`workspaceId`,`displayName`,`cron`,`prompt`,`outputConversationId`,`creatorId`,`nextFireAt`,`enabled`,`createdAt`)
VALUES
  ('t_seed_distill','system',NULL,'经验蒸馏（每周）','0 4 * * 0','[M5 占位] 蒸馏本周反馈与执行过程，产出经验写入 experience.md',NULL,'system','1970-01-01T00:00:00.000Z',0,'2026-08-16T00:00:00.000Z');