# Pi 无头驱动的 UI 握手风险（extension_ui_request）

## 背景

本项目用 `pi -p --mode rpc`（闲聊长连接）/ `pi -p --mode json`（工作流思考步一次性）无头驱动 Pi 作为唯一引擎。

## 证据

- `dist/modes/rpc/rpc-mode.js`：RPC 是长生命周期 JSON-lines server，把**所有 TUI 交互**（权限/批准弹窗、项目信任提示、`ExtensionUIDialogOptions`）作为 `extension_ui_request` 发出，客户端**必须**回 `extension_ui_response`。
- 实测 `pi -p --mode rpc "..."` 发一个 `setTitle` UI 请求后**静默卡死**——rpc 模式应忽略 `-p`，改从 stdin 发 `{type:"prompt",...}`。
- 可用 RPC 命令：`prompt`、`steer`、`abort`、`new_session`、`get_state`、`get_messages`、`get_commands`（枚举 skills 用它）等。
- 路径（本机全局安装）：`/Users/max/.nvm/versions/node/v24.13.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js`。

## 结论（教训）

无头驱动 Pi 时，**任何未被应答的 `extension_ui_request` 都会让 run 静默挂起**（没有报错、没有超时）。上线前必须：

1. 用 `-a` / `--approve` + settings 预批常规门（项目信任、工具权限）；
2. 枚举全量 `extension_ui_request` method（挖 `rpc-mode.js` + 扩展 UI 相关源码）；
3. 实现兜底应答器：未知请求按安全默认回（拒绝/取消），绝不留空。

## 适用场景

凡是把 Pi 当后端无头驱动的场景——本项目闲聊的 rpc 长连接、工作流思考步的 json 调用，都受此影响。建议在搭建 Pi 驱动层时**单开一个 spike** 把这条钉死。
