CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`userId` text NOT NULL,
	`title` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversationId` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`attachments` text,
	`createdAt` text NOT NULL
);
