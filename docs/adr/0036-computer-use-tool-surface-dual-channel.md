# 0036 - computer-use 工具面=双通道三工具 + 独立 `browser_*` 组（复刻 Codex/Claude 手感）

日期：2026-08-20（grill-with-docs grilling 定稿，Q4/Q14；经官方 schema 对表验证）

## 状态

已接受（设计意图）

## 背景

Q4 定界 computer-use 为**桌面级**（不止浏览器），桥复用 pi-computer-use（mac Swift / win·linux Rust，MIT）。但工具面不能照搬其 11 个 AX-first 工具：模型全程"看不见图"（只有折叠 outline）、canvas/图形 UI 全盲、单目标多次调用、服务端注册面与工作流声明繁琐——这与"复刻 Codex/Claude 操作手感"矛盾。官方 schema 证据（platform.claude.com computer-use-tool、developers.openai.com tools-computer-use、codex 源码）：两家的共性 = 视觉闭环（每动作后截图）、坐标=截图像素系+缩放回映射、浏览器自动化与 computer use **分开**；Codex 桌面插件的 `get_app_state` 正是"截图 + accessibility tree 一次返回"（双通道已被业界实证）。

## 决策

**D1 · 工具面 = 3 个 computer_use 工具 + 独立 `browser_*` 组**（服务端注册表 + 工作流 `tools` 声明的面，内核实为 pi-computer-use 桥，不改动）：

| 工具 | 职责 | 关键内容 |
|---|---|---|
| `computer_use.screens` | 列显示器/窗口 roots（标题/rect/聚焦）→ 模型选目标 | 吸收 pi-c-u `find_roots` |
| `computer_use.observe` | 观察：截图 + `scale` + `stateId` +（可选）AX outline | `mode:"visual"\|"visual+ax"`；吸收 `observe_ui` 快照语义 |
| `computer_use.act` | 原子动作：`click/dblclick/rightclick/type/hotkey/scroll/drag/move/wait`；目标=`{x,y}`（截图像素系）**或** `{ref}`（AX 语义）；**每个动作后必回后置截图** | 吸收 `act_ui` 事务验证 + 输入投递（语义优先→坐标兜底） |
| `browser_*` | 网页自动化走 CDP/DOM（导航/点击/填表/求值），**持久登录态在这层** | 吸收 `launch_browser/navigate_browser/evaluate_browser` |

**D2 · 语义规则**：
- **视觉主线、AX 挂件**：默认 `visual`（与标杆一致），`visual+ax` 供表单/文本 UI 精确定位与省 token；AX 缺失（无头低配）自动退纯像素，闭环不破。
- **软 stateId**：`act` 接受可选 stateId，设备侧 epoch 过期只提示"先 observe 再 act"，**不硬拒**——硬拒会打断 Codex 式长思考（这就是 pi-c-u 原设计在自由流上的最大摩擦点）。
- **坐标语义锁死**（Anthropic/OpenAI 一致 best-practice）：`act` 的 `{x,y}` 在 `observe` 返回截图的像素系，设备按 `scale` 换算物理像素；多显示器由 `display_id` 限定；截图按模型图片上限缩放（Claude 类 ≤2576px 长边）。
- **单动作/次**（Anthropic + Codex 插件式）：契合服务器 `tool_call→tool_result` 一对一与 120s 超时；OpenAI GA 式批量 `actions[]` 一截图留作协议扩展位（未来只扩 act 的入参，不动工具名）。

## 负决策

- **否决全量 11 工具照搬**：注册面重、模型看不着图、canvas 盲、与标杆体感不符。
- **否决纯像素（Claude/OpenAI 裸式）**：无 AX 兜底，表单/文本与动态 UI 只能盲猜。
- **不做实时画面流**：v1 快照（`tool_result.artifacts` 原生支持）；真机"围观"价值留作增强。

## 后果

- 模型 = 运行工作流的 pi——远端工具**仅经工作流 run 承载**（stub→bridge→device），chat 不能直接调（验证：stub 生成唯一入口在 `runs/lifecycle.ts:306-316` ctxFor，chat 路径无 stub、无 run nonce，最短路是 pi 经 `start_workflow` 桥间接触发）。
- 每 `act` 回 1 张截图：带宽/延迟可配（缩放 + 分辨率可设），体感 1~3s/cycle，与标杆一致。
- 有头真机可复验（人看着 + 设备本地同意）；无头环境退纯像素但授权弹窗缺失问题见 ADR-0037 后果。
- Backlog：批量 `actions[]`、内容感知截图裁剪（zoom 等价）、AX 树增量 diff。

## 关联

ADR-0033（D3 转发链路、工具注册表）、0034（客户端仓库承载执行器）、0035（`browser_*` 的 CDP 底座与登录态）、0037（Tauri 壳承载本地授权与启动）。