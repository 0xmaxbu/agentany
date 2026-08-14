# 前端技术栈：shadcn(Radix) + Tailwind v4 + 极简专业双模

V1 前端重构的技术栈与视觉基调。

## 决策

- **组件库**：shadcn/ui（**Radix 原语，经典**）+ Tailwind v4。废弃全部 inline-style。
- **视觉风格**：**极简专业**（Notion/Linear 调性：克制中性、留白、内容优先）+ Light/Dark 双模。
- **版本**：选经典 Radix（非下一代 Base UI/@shadcn/react）——生产验证、生态大，V1 重构不叠新技术风险；chat UI 参考 vercel/chatbot 自组。
- **渲染**：消息改 **parts/blocks 架构**（text/tool_use/thinking/tool_result 各 part 组件），与 #20 一致。

## 依据

调研：4/5 主流开源 chat（chatbot-ui、vercel/chatbot、shadcn-template、Cursor）用 shadcn+Tailwind；vercel/chatbot 用 Radix 做到生产级；极简专业契合专业工具调性 + shadcn 默认风格。

## 备选未采

- 下一代 `@shadcn/react` + Base UI（官方 chat 原语诱人——Questionnaire 对应 ask_user，但较新、风险；待成熟后再评估）。
- 完整组件库（antd/MUI，黑盒、强风格）。
- 手搓设计系统（V1 工作量过大）。

## 后果

- 前端体验重构规模：废弃 inline-style + 搭三区 shell + parts 渲染（含 #20）+ 修 UX 痛点（HITL 卡位置 / 流式 / 工具+thinking 显示）。
- 引入依赖：tailwindcss v4、radix-ui、react-markdown+remark-gfm、shiki、cmdk、sonner 等。
