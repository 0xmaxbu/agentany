# 真 auth：opaque token 存 DB

`auth-stub`（dev 桩：设 `AGENTANY_DEV_TOKEN` 校验 Bearer、否则放行；`userId = AGENTANY_DEV_USER ?? "dev-user"`）演进为真 auth。选 opaque token 存 DB。

## 决策

真 auth = **opaque token 存 DB**：users 表（账号 + 密码哈希）+ 管理员开通/注销 + opaque token 签发/校验（token 落 DB，可即时注销）。保留现有 Bearer token 通道（auth-stub 已是 Bearer）与 `userIdOf`（`c.var.user`）管线。

## 考虑过的备选（未采）

- **JWT**（无状态、签名自验）：注销难（需黑名单），内部团队小规模用不上无状态优势。
- **session/cookie**：引入全新机制（服务端会话 store + cookie），与现有 Bearer 通道不一致。

## 后果

- 需 users 表 + tokens（或 token 字段）+ 密码哈希 + 开通/注销 API。
- 注销 = 删 token 行（即时、简单），契合 CONTEXT「不接 SSO、管理员开通/注销」。
- auth-stub 保留为 dev/逃生阀（`AGENTANY_DEV_TOKEN` 未设时放行），真 auth 与之并存到 auth 阶段收口。
