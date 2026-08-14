// 首个管理员 bootstrap：env 设 AGENTANY_BOOTSTRAP_ADMIN_{USERNAME,PASSWORD} 时，boot 幂等 upsert 一个 admin。
// 未设 → 跳过（走纯 dev 阀）。env 是 bootstrap admin 真相源：改 env 改密 / 提权。
import type { UserStore } from "./store";

export async function bootstrapAdmin(userStore: UserStore): Promise<void> {
  const username = process.env.AGENTANY_BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.AGENTANY_BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) return;
  await userStore.upsertBootstrapAdmin({ username, password });
}
