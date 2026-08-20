-- ADR-0033 / R-1（#73）：远端执行四表——remote_clients / workflow_grants / workflow_cfg / pending_starts。
-- 建立远端执行功能的持久层（R-2 写 remote_clients；R-3 消费 grants+cfg；R-4 挂起-自动续用 pending_starts）。
-- FK 均指 users(id)：无物理删用户路径，FK 安全；PRAGMA foreign_keys=ON 已随 db/client 开启。
CREATE TABLE `remote_clients` (
	`userId` text NOT NULL,
	`deviceId` text NOT NULL,
	`deviceName` text,
	`lastSeen` text NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`userId`,`deviceId`),
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `remote_clients_userId_idx` ON `remote_clients` (`userId`);
--> statement-breakpoint
CREATE TABLE `workflow_grants` (
	`workflowId` text NOT NULL,
	`userId` text NOT NULL,
	PRIMARY KEY(`workflowId`,`userId`),
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_grants_workflowId_idx` ON `workflow_grants` (`workflowId`);
--> statement-breakpoint
CREATE TABLE `workflow_cfg` (
	`workflowId` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pending_starts` (
	`id` text PRIMARY KEY NOT NULL,
	`workflowId` text NOT NULL,
	`userId` text NOT NULL,
	`deviceId` text NOT NULL,
	`envStatus` text NOT NULL,
	`reason` text,
	`createdAt` text NOT NULL,
	`ttlAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);