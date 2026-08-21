# 0035 - 浏览器层=统一 CDP + 登录态设备本地归属（ego 退化为 Mac 容器）

日期：2026-08-20（grill-with-docs grilling 定稿，Q2/Q6/Q10）

## 状态

已接受（设计意图）

## 背景

原始方案用 lite.ego.app（仅 macOS，且是 skill 形态非服务接口）做跨平台浏览器后端，不成立——Windows/Linux 装不了、也无法当本地服务被调度。但用户核心诉求明确：**保存用户登录态（最重要）+ 模拟真实用户操作**。调研结论：跨平台浏览器自动化唯一干净的接口是 CDP（一家两家都实证了这一点）；ego 的价值被重新定位为"Mac 上自带已登录态的 Chromium 提供者"，而不是架构核心。

## 决策

**D1 · 统一 CDP 驱动**：浏览器工具只有一种实现 = CDP 对话"本机 Chromium"。Mac 上 CDP 端点是 **ego 的 Chromium**（客户端内置 ego 适配器、连其 loopback 端口；ego 为可选项安装）；Windows/Linux 端点是**本机自启的 Chrome/Edge**（`--remote-debugging-port`，客户端管理生命周期）。浏览器能力边界 = Chromium 能力（不支持 Firefox/WebKit）。

> **2026-08-21 修订**：ego 适配暂缓（backlog）——实测 ego 默认不暴露 TCP CDP 端口（官方通道是 ego-browser CLI 桥，citrolabs/ego-lite #285），且首启 onboarding/导入坑多；v1 三平台统一**自启 Chrome/Edge + 专用非默认 `--user-data-dir`**（Chrome 136 起默认目录禁 remote-debugging，专用目录同时保住 debugging 与登录态持久）。CdpConnection 接口保留 ego 适配器位。

**D2 · 登录态与真实用户模拟（一等需求，位于浏览器层）**：
- **持久 profile**（非临时非无痕）：cookies/localStorage/登录态跨会话存活，目录在设备本地；
- **UA 与指纹可配置**（`Emulation.setUserAgentOverride` / 启动旗标），输入事件走真实路径轨迹而非瞬移——用于自身账号与已授权场景的合规自动化；
- 会话稳定性优先于激进伪装（稳定指纹 > 每请求换头）。

**D3 · 登录态设备本地归属（信任边界）**：登录态/cookie 原文**只存设备本地**，服务器与远端操作者拿不到；远端动作 = "借用设备用户已授权会话" 在设备用户名下执行。首次把已登录的浏览器/桌面会话绑定给远端使用 → 设备本地弹窗确认一次（与 ADR-0033 D7 的 `env_remediated` 同一授权机制）。每次工具动作的产物（截图等）照常回传，cookie 永不外传。

## 负决策

- **不用 Playwright MCP / agent-browser / Chrome DevTools MCP 作浏览器后端**：引入独立服务的复杂度 > 自己薄实装 CDP（pi-computer-use 的手写 CDP 客户端已验证可行、MIT 可移植）。
- **不做实时画面流**：v1 动作后快照（见 ADR-0036）；流式留作增强。

## 后果

- Mac 设备可选装 ego 获得"已登录态共享 Chromium"；无 ego 时 Mac 也回退本机 Chrome（同为 CDP）。
- Win/Linux 需要处理首次浏览器启动（可能弹用户确认）与端口约束（loopback 白名单）。
- 安全面由 D3 收敛：设备用户是登录态的所有者与授权者，授权动作本地可见、可撤（配合单机顶号语义）。
- Backlog：指纹配置持久化、多浏览器 profile 切换、cookie 到期联动提示。

## 关联

ADR-0033（D3 转发链路、D7 本地授权弹窗复用）、0034（客户端仓库承载浏览器适配器）、0036（browser_* 工具面）。