-- #41/T1（ADR-0025）：run 生命周期零 LLM 简报——终态写简报列；发信后回填消息 id（启动对账幂等锚）。
-- brief 与终态同事务写（崩溃封堵）；briefMessageId null=未发（对账补发扫瞄键）。
ALTER TABLE `workflow_runs` ADD `brief` text;
--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `briefMessageId` integer;