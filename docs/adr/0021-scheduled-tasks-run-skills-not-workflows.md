# 0021 - 定时任务只跑内部 skill，不触发工作流；系统作用域不实体化为 workspace

日期：2026-08-15（PRD v1 路线 grilling 定稿）

## 状态

已接受

## 背景

v1 路线（`docs/prd-v1-roadmap.md`）把定时任务与经验提取纳入范围。直觉设计是「cron 按计划自动启动工作流」（术语表原文即如此），但工作流含 HITL/审批语义——无人值守触发后挂起等谁答？审批门「审批只来自人类」（QM）与「配置即永久预授权」又构成镜像漏洞。

同时，v1 唯一的 cron 任务（每周经验蒸馏）要写的 skill 文件**不属于任何 workspace**（repo 级），而 skill 读写又需要一条对用户不可见的通道——最初设想建「SYSTEM WORKSPACE」实体承载。

## 决策

1. **定时任务 = 按计划跑一个内部 skill**（pi 子进程执行，如 `experience-distill`），**不触发工作流**。工作流只能由人在场触发（chat 桥接 / admin UI 手动）。cron 仅承载「LLM 可独立完成、无人值守安全」的任务。
2. **任务两类 scope，v1 只落 system**：`system`（跨 workspace，挂系统实体，如蒸馏）/ `workspace`（挂单 workspace，v1 只设计不实现）。不绑定「cron 必须挂 workspace」。
3. **系统作用域（System scope）是正交维度，不建 workspace 实体**：专用系统目录 + 专用读写工具，**只在 cron 触发的 pi 运行时注入**（放独立目录如 `system-skills/`，仿 `chat/extensions/` 先例，不进 repo `skills/` 自动发现区）。注入面即权限面——普通 chat/工作流 run 的 pi 根本没有此工具。不建「SYSTEM WORKSPACE」行，避免给 ADR-0018「无类型纯名单」开第一个类型洞。
4. **创建双入口、服务端强校验**：chat 对话（LLM 经工具建）与 admin UI 均可创建，服务端一律校验 admin 角色（非 admin 工具调用 403）。与审批门同一姿态：不靠「工具不注入」做权限，靠服务端强制。
5. **停机错过窗口只记 missed 不补跑**（数据留待下次窗口一并处理）；**所有定时任务支持 admin 手动调用**。

## 后果

- CONTEXT.md 术语表：重写「定时任务」、新增「系统作用域」。
- 服务进程不直连 LLM API——所有 LLM 调用（含 cron）统一走 pi 子进程，复用沙箱/超时/审计。
- 工作流的周期性需求（如每周调研）由 admin 手动触发或未来的「提醒类」机制满足，不走 cron。
- v1 不做：workspace scope 任务、失败重试、补跑、多时区。
