-- ADR-0030（#67/A1）：ask 卡决策素材 context 一等列——退役 input-as-{context} 走私
-- （0019 计划号因 ask_card_values 迁移占用而顺延；现直列，hitl-dispatch/前端零行为变化）。
ALTER TABLE `hitl_questions` ADD `context` text;