-- #37/M5-4：蒸馏周任务启用（M4 种时 enabled=0 占位；M5 三片落地后装配）。
-- 周日 04:00 跑（避开整点——fleet 礼貌）；nextFireAt 留 epoch 由 reviveSeedNextFire 启动算真值。
UPDATE `scheduled_tasks` SET `enabled` = 1 WHERE `id` = 't_seed_distill';
