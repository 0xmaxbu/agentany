# 0037 - Tauri 客户端形态 + macOS 先行 phasing + 执行仅经 run 承载

日期：2026-08-20（grill-with-docs grilling 定稿，Q3/Q8/Q13/Q15）

## 状态

已接受（设计意图 + 落地顺序）

## 背景

ADR-0033 D7 规定环境补全的本地授权**只做在设备客户端 UI**（不进 web、不进 IM）——没有可弹窗的客户端形态，`env_remediated` 与浏览器会话绑定授权（ADR-0035 D3）都无处安放。客户端又是一个大工程（Tauri 壳 + 三平台 native 桥 + 浏览器适配 + WS 客户端），需要定形态与排期；同时要钉死"谁可以触发设备执行"。

## 决策

**D1 · Tauri 桌面应用**：托盘常驻 + 本地授权弹窗（`env_remediated` / 浏览器会话绑定共用）+ 开机自启 + 三平台安装包。Rust 与 computer-use native 桥（win·linux bridge-rs）同工具链，一个生态拿下壳与桥。

**D2 · 实施顺序 macOS → Windows → Linux**：Mac 链路最短（ego 现成可直接验证登录态主诉求、Swift 桥现成、Tauri mac 打包最顺），先跑通"持久登录态浏览器 + 桌面 computer-use"闭环，再补 Win/Linux 桥。

**D3 · 执行承载面（补钉）**：远端工具**仅经工作流 run 执行**（stub→bridge→device，ADR-0033 D3）；chat 不能直接调用（chat 路径无 stub、无 run nonce），唯一路径是 pi 经 `start_workflow` 桥间接触发。一旦设备断线/被顶号，在飞 `tool_call` 失败 → run failed 记因（沿用 0033 D8 失败即通知）。详见 ADR-0036 后果的验证引用。

## 负决策

- **不用 Electron**：bundle 与运行体积重，且无 Rustin 桥协同。
- **不做直接派单 / web 设备控制台（v1）**：远端按需动作=借用设备用户已授权会话（ADR-0035 D3）的敏感面；v1 收敛到 run 链路，设备管理视图留作增强。
- **不做实时画面流**：与 0035/0036 一致，v1 快照。

## 后果

- 设备侧权限要求：macOS TCC（辅助功能 + 屏幕录制）；Windows 交互式桌面会话；Linux 图形会话 AT-SPI2 总线（对应 0033/0036 各平台约束）。
- **无头机器授权 open point**：无托盘 UI 的 headless 设备（Q3 c 的无头形态）如何确认 `autoInstall`/会话绑定——CLI 确认、受信白名单、或暂不支持三种候选，留给客户端建档/实施时定（backlog）。
- 三平台发布依赖签名/公证链（mac 公证、win 签名）——排期前置。
- Backlog：设备管理页与在线列表、直接派单、实时画面流、无头授权方案。

## 关联

ADR-0033（D7 本地授权、D4 单机登录/顶号）、0034（独立仓库承载 Tauri 壳）、0035（会话绑定授权弹窗复用）、0036（执行仅经 run 承载的验证）。