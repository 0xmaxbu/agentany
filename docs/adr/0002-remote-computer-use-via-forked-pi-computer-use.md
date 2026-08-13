# 远程 computer-use：fork pi-computer-use，网络化它的 native helper 传输

computer-use 必须跑在带桌面的远端机器（服务器无头），且**生产环境没有 Orca**（仅 dev 有）。决定：**fork `injaneity/pi-computer-use`（MIT、Pi 扩展、Rust+TS+Swift、Orca-free、macOS/Win/Linux 原生无障碍），只改一刀——把它的 native helper 传输（现状随 Pi 跑在本地：macOS socket server / Windows 线协议 / Linux JSON-lines 子进程）改成经 WebSocket 连远端桌面**。服务器侧 TS 后端 + Pi 工具定义不变；桌面侧 native helper 不变、前面加一个薄 WS 桥；协议复用 pi-computer-use 既有的 request/id JSON-lines + state-scoped 工具契约（`find_roots/observe_ui/act_ui…`、`@rN`/`@eN`/`stateId`/epoch），我们只补三件：鉴权（受信客户端）、能力注册（客户端声明"我有桌面 helper"）、多客户端路由（服务器持已连桌面池、按资源转发）。

## 备选

- **Orca + `orca serve` / `--environment`**：否。**生产无 Orca**，生产路径走不通；且 Orca 的 computer-use 是 CLI、无 Python SDK、索引每步失效（pi-computer-use 用 stateId/epoch 解决了）。
- **从零自建 computer-use（含协议）**：否。pi-computer-use 已有成熟 state-scoped 实现（事务批次 + 后置条件、截图证据、浏览器 CDP）+ 三平台原生 helper；重造没意义。
- **上游 pi-computer-use 原样用**：否。它仅本地（Pi 与 helper 同机），够不着远端桌面。

## 后果

- v1 只立服务器侧：装上 fork 后的扩展，Pi 工具就位、传输指向"远端 WS 池"，无客户端连接时优雅降级。桌面客户端（native helper + 薄 WS 桥）= **v2**。
- **全栈无 Python**（早先"Python 客户端"设想作废；computer-use 的实现就是 pi-computer-use 的原生 helper）。
- 桌面客户端拓扑：**出站拨号**到服务器 WS（穿 NAT 友好）→ 转发到本机 helper socket。
- macOS 客户端需授予 Accessibility + Screen Recording 权限。
