# WORKSPACE 实体：作用域+权限的唯一原子单位

废除 ADR-0013/0014 的「项目实体」决策（supersede）：PROJECT 只留**逻辑概念**（一次客户/品牌 engagement 的通称），系统里以 workspace 承载（如为 engagement `acme` 建 ws）。**WORKSPACE = 可访问目录 + 权限控制的唯一原子单位**。

## 决策

1. **无 type**。不给 workspace 分公司/部门/个人/项目等类型——代码逻辑不因类型分叉：任何 ws 都是「一个目录 + 一份权限」。部门级/个人级将来只是数据层面的用法差异，无 schema/代码分支。
2. **权限 = `allUsers` 布尔 ∪ 可访问名单**（workspace_members 表）：
   - `allUsers=true`：全体**在职**用户可访（名单读时 join users 过滤 active，悬空行不清理——留作审计痕迹）；
   - 名单：显式点名；与 allUsers 允许并存、不校验互斥（查询语义不变，UI 互斥是展示层的事）。
   - admin（用户级 role）短路全通（dev 阀派生的 dev-user 即 admin → dev 流程不破）。
3. **仅 admin 可建/可管**（创建、改名、改 allUsers、增删名单成员）。多级「创建权限位」推迟到真需求（避免 speculative generality）。
4. **默认公司 workspace**：固定 id `ws_company`（slug `company`，allUsers=1），由迁移 seed（`INSERT OR IGNORE`）——所有库（含测试 :memory:）天然具备，零 bootstrap 代码。请求缺省 workspaceId 一律落它。
5. **会话一律创建者私有**（+admin）：对话隐私与 ws 权限是**两个正交维度**——ws 名单管「目录+run」，会话是私人对话实体。团队共享会话的扩展点 = 将来加 `conversations.visibility`（private|workspace）列 + canAccessConversation 第三分支；v1 不预铺列。
6. **PROJECT 废除实体**：DROP projects/project_members 两表 + conversations/workflow_runs 的 projectId 列；`src/projects/` 模块整体删除。历史诚实：0008 建、0009 弃（append-only 迁移）。
7. **目录锚（纯函数，不查表）**：`ws_company` → 沿用 `data/general/`（原 general scope 语义即「全用户共享通用区」，文件零迁移）；其余 → `data/workspaces/<wsId>/{workspace,pi-sessions}`。旧 `data/projects/p_*` 目录原地保留不迁移（历史文件）。
8. **API**：workspaceId 取代 projectId（conversations/runs 全线）；不设兼容别名（解耦后项目 id 无映射意义；web 仅 2 处机械改）。

## 理由

- grill 会话结论：type 删除源于「逻辑不随类型分叉」——任何分类法（公司/部门/个人）都会随组织现实膨胀，而权限语义（谁能进这个目录）永远只有「全员/名单」两种。
- 项目实体（step b，`7f9cb76`）落地两周即被取代：把「作用域」与「组织归属」捏在一个实体里是过度建模——engagement 的组织语义（谁负责、给谁汇报）与文件可见性（谁能访问目录）不是一回事。ws 只做后者。
- 会话创建者私有：所有 allUsers ws 下的会话若跟随 ws 权限，则任何用户可读所有同事的对话——隐私面不可接受。

## 后果与已知债务

- 术语表「项目/项目成员/角色/会话」条目同步改写（CONTEXT.md）。
- 定时任务（ADR-0013，将来落地）归属从「项目」改挂 **workspace**（cron 起 run 需要 ws 锚定目录+权限）。
- 推迟：ws 级角色（owner，管权下放）、conversations.visibility、ws 删除/archive、多级创建权限、名单管理 UI。
- run 不再有 userId 列：公司 ws 的 run 全员可见（共享语义）；名单 ws 的 run 名单可见——run 可见性严格随 ws，无私有 run 概念。
