# 用 Drizzle 做 DB 解耦：v1 SQLite，以后换 Postgres

数据访问走 **Drizzle**（查询构建器），v1 落 **SQLite**，将来换 **Postgres** 只改 driver + 少量方言、业务码不动。一个库存全部：工作流 run 状态、审计日志、users / projects / memberships / conversations / uploads 元数据。上传文件与报告落磁盘 per-project 工作区，路径入库。审计日志记"谁、哪个项目"的每次能力/工作流调用 + 工作流每步。

## 备选

- **手搓 Repository 接口 + SQLite/PG 两套实现**：否。要自维护接口、手写两套 SQL，成本高。
- **Prisma**：否。运行时重、生态绑定深，与"手搓、不引重框架"的整体风格不一致。
