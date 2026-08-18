-- #60/T5（spec #55 决策 7 修订）：自助绑定码——一次性凭据。Web 领码 → 私聊 bot `#bind <code>` 消费。
-- code 4 位数字主键（ADR-0028 决策 2 修订；TTL+单次消费兜底）；usedAt CAS 单次消费（重放拒）；expiresAt 超时兜底。
CREATE TABLE `im_bind_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	`expiresAt` text NOT NULL,
	`usedAt` text
);
--> statement-breakpoint
CREATE INDEX `im_bind_codes_user_idx` ON `im_bind_codes` (`userId`);