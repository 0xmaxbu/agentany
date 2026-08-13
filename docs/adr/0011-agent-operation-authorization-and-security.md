# 0011 — agent 操作授权与安全架构

管理类功能（项目/人员/定时任务/文件…）会**经 chat 让 Pi 操作**（做成 extension，Pi 调用），且 cron 后台任务也会跑 agent。于是需要一个**跨切的授权模型**：Pi 调任何管理操作都要验发起人权限；**destructive/impersonation 等敏感操作禁止 agent 执行、必须手动**；cron 绝禁敏感操作。并经一轮对抗安全审查（4 路盲扫 + 核到真实代码）发现：**授权 gate 是必要但不充分**——真正暴露面在沙箱缺失、agent 可读的信任材料、自动加载的 LLM-written 上下文、注入无防御。本 ADR 定模型 + 已应用 hotfix 基线 + 架构改路线（A1–A14）。

前置：ADR-0005（Pi 加载）、0006（项目隔离）、0007（工作流引擎）、0008（执行/反馈/学习）、0009（chat）。威胁模型与已知局限见 `SECURITY.md`。QM（yc-software/qm）的安全设计为本 ADR 的实证参考。

## 授权模型（四概念）

| 概念 | 取值 | 说明 |
|---|---|---|
| **Principal 主体** | `user`（chat/admin）/ `system`（cron） | 谁发起。**身份服务端绑定，绝不信 LLM 自报**（A4） |
| **Channel 通道** | `chat` / `admin-ui` / `cron` | 从哪发起，决定能触哪类操作 |
| **Tier × Decision** | tier `read/write/destructive` × decision `allow/deny/require_approval` | read/write+权限→allow；destructive→portal-only(deny from pi)；边界→require_approval(HITL) |
| **Permission 权限** | 粗粒度 = `admin` 角色 + 项目成员关系（scope） | QM 式单一 admin 角色 + scope ACL；细粒度 `{resource:action}` 作未来精化 |

**每个操作/extension 声明** `(requiredPermission, tier, channels)`。Gate 据此 + principal 判定。

## 安全要点（构造性）

- **绝不信任 agent 自报身份**：principal 服务端绑 **capability token**（JWS HS256 + 常量时间比较，借 QM `signed-token`），token **不在 Pi 可读空间**（env/argv/cwd/loopback 它能说的）——走 UNIX socket + server session map（A4）。
- **deny-by-default**：cron 通道 `principal=system`，只放其本职；管理 extension 的 `channels` 不含 cron → gate 直拒。
- **单一 chokepoint**：所有 Pi extension 调用过一个 `authorize()` gate。
- **least privilege**：Pi 只看得见它能调的工具——destructive/impersonation/authz-change **根本不注册为 extension**（portal-only 墙，借 QM `SECURITY.md:86-107`：授权未来 agent 行为的决策必须来自 agent 之外）。
- **fail-closed**：判定解析非明确 allow 即拒（借 QM `parseSecurityScreenVerdict`）。

## 三个执行点

1. **注册期**：destructive 不进 Pi extension 注册表（只作 admin HTTP 路由存在）+ **构建期测试**：任何标 destructive/impersonation/authz 的 op 被注册进 Pi toolset 即 fail。
2. **调用期 gate**（Pi extension，含 ADR-0009 Q6 桥接工具）：`authorize({token, op, args})` → 解析 principal → 验 perm + tier + channel → 过则执行、否则拒（Pi 告诉用户"无权限/需手动"）。**op 名绑服务端 capability**（`{opId,tier,handlerRef}` 注册表拥有），禁 agent 自报；tier 静态分析派生、禁自报（A5）。
3. **边缘 gate**（HTTP/管理 UI）：标准 RBAC（session→user→roles→perm）。

## 已应用 hotfix 基线（代码级，本安全审查后落地）

`SECURITY.md`「已防御」表：h1 projectId 校验 / h2 input 校验+slugify / h3 去 argv 密钥+env 白名单 / h5 loopback+dev-token+body 上限 / h6 DATA_DIR 统一 / h7 resume 串行锁 / h8 强 runId / h9 Pi 并发信号量 / h10 foreign_keys。这些是**减速带**，真正隔离边界是下面的 A1–A14。

## 架构改路线（A1–A14，按优先级）

| 优先 | 项 | 内容 | 修掉的审查发现 |
|---|---|---|---|
| **P0** | **A1 Pi 沙箱** | bwrap/microvm/Docker，ro-bind 只工作区，绝不 ro repo 根/.env/源码/DB/~ | 无沙箱致密钥/全盘/主机沦陷、命令策略绕过、DB 篡改、skill 后门（一招修 ~7 条 CRITICAL/HIGH） |
| **P0** | **A2 真 auth+RBAC+项目成员** | principal 从 session 派生、projectId 不信 body、每读/写/resume 按 membership scope、404 非 403 | 零鉴权跨租户、projectId 由 body、resume 劫持 |
| **P0** | **A4 信任材料不进 Pi 可读空间** | turn-secret 走 UNIX socket+server session map（非 env/argv）；per-turn 一次性；transcript redact | turn-secret 被_pi 读出重放/伪造 |
| P1 | A3 Pi 网络隔离离 127.0.0.1:3000 | netns 或 loopback 内部 HMAC（Pi 不持有） | localhost SSRF 自驱动 |
| P1 | A6 DB 隔离 | Pi 独立 OS 用户无 DB 权 / per-project sqlite / 查询层强制 `WHERE projectId IN(memberships)` / state 从签名 log 派生 | DB 跨租户读写/篡改/伪造 |
| P1 | A7 experience.md 审查门+per-project | 提取输出 quarantine+人审才 auto-load、per-project（砍 ADR-0009 Q10=a defer）、结构化记录无祈使、feedback 加 projectId+auth+scope、第二道 LLM 剥祈使 | experience.md 持久跨用户/项目投毒 |
| P1 | A5 gate 服务端 capability | opId/tier/handler 服务端注册表、tier 静态分析、构建期测试 | op/tier 在 gate 被篡改（声称≠执行） |
| P2 | A8 命令策略服务端化+允许式 | interpose Pi tool 协议、allow-list（主要靠 A1） | 命令策略在 pi 内、write-then-exec 即破 |
| P2 | A9 skill 完整性 | allow-list 名+hash-sign SKILL.md+dev ro-bind skills+写路径与发现根不重叠 | 丢 skill 持久后门 |
| P2 | A10 web 出站筛 | URL allow-list+secret 扫描+经服务端代理+pin tavily 网关 | 经 web 工具外发密钥 |
| P2 | A11 audit 独立 sink | Pi 不可写、append-only/hash-chain/远程 | audit 未建且计划在同 sqlite 可删/伪造 |
| P2 | A12 runId/conversation 绑定 | runId 只从 server pending-run 注入、非 NL；`run.conversationId===current` | resume 跨 run/会话劫持 |
| P3 | A13 taint tracking | 自写文件标 derived-untrusted、读时降权；compaction summarizer 只摘要事实不保祈使 | 自注入、compaction 驻留注入 |
| P3 | A14 ask_user provenance | "agent 在问"溯源戳+破坏性选择键入确认 | ask_user UI 伪造社工 |
| defer | posture 轴 / Auto 分类器 / per-scope keychain / WORM audit / 完整 egress proxy / 4-backend sandbox / leader-lease cron | 见 SECURITY.md 已知局限 | 注入深度防御、多用户凭证 |

## 备选（已否决）

- **细粒度 `{resource:action}` RBAC（原推荐）**：否。QM 实证同类应用**单一 admin 角色 + scope ACL** 够用；选粗粒度，细粒度作未来精化。
- **posture 命名轴现在立**：否（defer）。吸收其 deny/approve 区分进 tier×decision；Auto 分类器/screening 整体 defer。
  - **#18 窄口径重引入（2026-08）**：ticket #18 为 `start_workflow` 桥接路径加了 `SECURITY_POSTURE`（dangerous/auto/strict）+ `CommandPolicy` 门——但**仅 workflow 启动门**（allow/deny/require_approval），**非**通用 `authorize()` chokepoint。复用 #16 的 `hitl_questions` 发审批卡，**人类**经 main app `POST /approvals/:id/decide` 批准（bridge 无此端点 + pi 沙箱禁 main app loopback → pi 无自批）；fail-closed（auto 无规则→deny）；审批审计落 DB。详见 `security/policy.ts` 顶部声明 + `SECURITY.md`。A2 真 auth 阶段统一收口（届时按 principal/channel 判定，posture 或并入 tier×decision 或独立保留）。
- **per-project experience 现在 defer（ADR-0009 Q10=a）**：**推翻**——安全审查证其是跨用户持久投毒根因，A7 必做。
- **reject-429 并发（chat 队列的备选）**：见 ADR-0009（选排队）。
- **命令策略黑名单作主防线**：否。审查证 write-then-exec/编码即破；命令策略只是减速带，真隔离靠 A1。

## 后果

- 安全 gate（`authorize` + capability token + opId 注册表 + portal-only 构建期测试）随切片②桥接工具一起上。
- **A1 沙箱是切片①后端"裸跑 Pi"的前置**——dev 也须最小沙箱（否则 SECURITY.md 已知局限 #1 恒成立）。
- A2/A4/A6/A7 为多用户/多项目前置。
- SECURITY.md 随每次架构改（A1–A14）更新「已防御」与「已知局限」两表。
- 借鉴 QM：capability token=JWS+常量时间、fail-closed 判定、portal-only 墙原则、`safeJoin` 8 行、`min-release-age=7` 供应链冷却（npmrc）——逐条标进 `docs/chat-frontend-borrowed-patterns.md` 旁的安全借鉴清单（待建）。

## 关联
`SECURITY.md`（威胁模型+已知局限）、ADR-0005/0006/0007/0008/0009、QM（`github.com/yc-software/qm` SECURITY.md + `src/security/`、`src/policy/`、`src/credentials/`）。
