-- #39/M6-1 ADR-0023 决策 3：system 任务任务级最小权限双开关。
-- allowWrite 缺省 1（=历史行为 rw）；allowSearch 缺省 0（不加载搜索扩展）。
-- （drizzle 迁移走 prepare()：注释前导+多语句会静默吞掉第二句——statement-breakpoint 必须有。）
ALTER TABLE `scheduled_tasks` ADD `allowWrite` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `allowSearch` integer NOT NULL DEFAULT 0;
