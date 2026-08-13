CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`targetKind` text NOT NULL,
	`targetId` text NOT NULL,
	`text` text NOT NULL,
	`rating` integer,
	`createdAt` text NOT NULL
);
