// IM 私聊命令解析（spec #55/T5）：`#bind <code>` / `#unbind`。平台无关纯函数——语法契约在此，
// 消费/绑定/补发在调用方（feishu inbound glue，处理到 send 的最后一公里）。
export interface BindCommand { kind: "bind"; code: string; }
export interface UnbindCommand { kind: "unbind"; }
export type ImCommand = BindCommand | UnbindCommand;

/** 私聊文本 → 命令；非命令 → null（进文本回流）。绑定码 = 4 位数字（与 issueBindCode 同契约）。 */
export function parseImCommand(text: string): ImCommand | null {
  const t = text.trim();
  if (t.startsWith("#bind ")) {
    const code = t.slice("#bind ".length).trim();
    if (/^\d{4}$/.test(code)) return { kind: "bind", code }; // 严格 4 位数字（防打字拖空格/混字母进回流）
    return null;
  }
  if (t === "#unbind") return { kind: "unbind" };
  return null;
}