-- #34 审查 Spec-4：feedback 行落作者（回显按人过滤——admin 看他人会话不再把他人反馈高亮成自己的）。
ALTER TABLE `feedback` ADD `authorId` text;
