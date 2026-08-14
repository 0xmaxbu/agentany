// unknown → 错误消息文案（store 层通用小工具）。
export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
