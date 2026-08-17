-- #46/T3（ADR-0025 决策 5/6）：ask 挂起强制卡 value 快照——显式 {label,value} 映射落库（卡自包含，
-- 重启/改 workflow 定义不失效）；value 只服务端消费（点选查表），前端仅收 label。
ALTER TABLE `hitl_questions` ADD `values` text;