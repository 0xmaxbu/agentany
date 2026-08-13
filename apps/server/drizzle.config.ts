import { defineConfig } from "drizzle-kit";

// drizzle-kit generate 只读 schema 产 SQL，无需 DB 连接；dialect=sqlite。
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
