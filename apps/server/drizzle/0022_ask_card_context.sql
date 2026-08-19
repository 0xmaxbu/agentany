-- ADR-0030（#67/A1）：ask 卡决策素材 context 一等列——退役 input-as-{context} 走私
-- （registry 曾以 {context} 包装塞进 input 列、toQuestionRow 反解；现直列，hitl-dispatch/前端零行为变化）。
ALTER TABLE `hitl_questions` ADD `context` text;