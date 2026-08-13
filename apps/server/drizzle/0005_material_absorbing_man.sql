CREATE TABLE `hitl_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversationId` text NOT NULL,
	`runId` text NOT NULL,
	`prompt` text NOT NULL,
	`options` text NOT NULL,
	`resumeSchema` text,
	`multiple` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer` text,
	`createdAt` text NOT NULL,
	`answeredAt` text
);
