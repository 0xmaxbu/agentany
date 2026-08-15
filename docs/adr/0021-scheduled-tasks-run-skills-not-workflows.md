# 0021 - 定时任务只跑 LLM 任务，不触发工作流；系统作用域不实体化为 workspace

日期：2026-08-15（PRD v1 路线 grilling 定稿；同日 M4 实践层 grill 两轮修订：任务本质+权限模型）

## 状态

已接受（2026-08-15 修订：任务=LLM 制定的自由 prompt 任务；member 自建自批；对话可改任务）

## 背景

v1 路线（`docs/prd-v1-roadmap.md`）把定时任务与经验提取纳入范围。直觉设计是「cron 按计划自动启动工作流」（术语表原文即如此），但工作流含 HITL/审批语义——无人值守触发后挂起等谁答？审批门「审批只来自人类」（QM）与「配置即永久预授权」又构成镜像漏洞。

最初设想建「SYSTEM WORKSPACE」实体承载 skill 读写特权。M4 实践层 grill（同日第二轮）进一步澄清：用户随口说的「每 4 小时去 xx 网站读新闻发摘要」不是预定义 skill——是 **LLM 依据用户 prompt 制定的自由任务**。skill 引用模型被推翻。

## 决策

1. **定时任务 = 按计划跑一个 LLM 任务**（pi 子进程执行），**不触发工作流**。工作流只能由人在场触发（chat 桥接 / admin UI 手动）。cron 仅承载「LLM 可独立完成、无人值守安全」的任务。
2. **任务本质=自由 prompt 任务**：用户在 chat 里说需求 → LLM 解析出 cron 表达式 + 任务目标 prompt → 落 ScheduledTask 表（每行=cron + 任务 prompt + 产出会话 + workspace 归属）。到点执行=pi 以该 prompt 为输入跑（同 chat turn 沙箱：绑 ws cwd、skills ro、tavily 基础网络）。预定义 skill 任务（如经验蒸馏）作为 `system` 级 seed 行共存。
3. **两类 scope 都落地**：`workspace`（用户随口建的任务，绑建时的 ws）/ `system`（跨 ws 内置任务，如蒸馏，代码 seed、admin 可见）。
4. **产出投递会话**：建任务时自动建一个「产出会话」挂同 ws；到点跑完把产出投递进该会话（复用现有消息链路，用户开 chat 即见历史产出）。
5. **建时门控（创建即授权）+ member 自建自批**：任何 ws 成员可在 chat 里建任务——LLM 出**任务卡**（cron 人类可读描述+接下来 3 次执行时间+任务目标）→ 用户点确认即建（自建自批，无需 admin 审批）；CommandPolicy 仍生效（deny→拒；require_approval→发审批卡给 admin，批了才入库）。频率下限（默认 1h）服务端强校验，挡错解析（「每 4 小时」被 LLM 错解成每分钟）。执行时不再逐次问（无人值守）。
6. **系统作用域=服务端代码的装配权，不是给 pi 的特权**：跨 ws 数据（如蒸馏要读的各 ws pi session）由**服务端**装配成最小切片（临时目录），蒸馏 pi 只读该切片、只能写临时目录；写回（skills/experience.md、learnings/）由服务端校验路径白名单后执行 + git commit。pi 全程无跨 ws 读写能力——不需要 system workspace 给 pi 开权限，失控面为零。「系统作用域」的独立注入目录（system-skills/）概念废止——蒸馏不需要它。
7. **管理三面**：admin 管理页（全部任务：查看/停用/手动跑/删除，含 system 任务）；member 在 chat 右侧面板或对话中管理**自己建的**任务；chat 对话支持**改任务**（LLM 定位旧任务→改 cron/prompt→新任务卡确认）。**system scope 任务（如蒸馏）经 chat 删除/停用一律服务端硬拒**（LLM 禁删系统任务，只有 admin UI 能）。
8. **停机错过窗口只记 missed 不补跑**；同任务在跑→本轮跳过记 `skipped_overrun`（不同任务并行、同任务串行）；**所有任务支持手动调用**（admin 管理页；member 自己的任务在面板）。

## 后果

- CONTEXT.md 术语表：重写「定时任务」、「系统作用域」（口径改为服务端装配权）。
- 服务进程不直连 LLM API——所有 LLM 调用（含 cron）统一走 pi 子进程，复用沙箱/超时/审计。
- 工作流的周期性需求（如每周调研）由 admin 手动触发或未来的「提醒类」机制满足，不走 cron。
- chat-bridge 工具面扩大：scheduled task 工具对 member+admin 都注入；system 任务的删除/停用经 chat 硬拒（服务端校验 scope）。
- v1 不做：失败重试、补跑、多时区。
