-- #51/T2（spec #49 决策 6）：IM 身份绑定表——imUserId+platform → agentany userId。
-- 管理端静态绑定（v1 无自助注册）；解析幂等；一用户每平台至多一个绑定。
CREATE TABLE `im_bindings` (
	`imUserId` text NOT NULL,
	`platform` text NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`imUserId`,`platform`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_bindings_user_platform_idx` ON `im_bindings` (`userId`,`platform`);