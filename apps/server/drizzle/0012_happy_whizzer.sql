ALTER TABLE `workspaces` ADD `archivedAt` text;--> statement-breakpoint
CREATE INDEX `conversations_user_ws_active_idx` ON `conversations` (`userId`,`archivedAt`,`workspaceId`,`updatedAt`);