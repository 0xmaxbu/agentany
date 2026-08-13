# 工作流：合成三步（synthetic-3step）

> 类型：**测试夹具**（验证引擎：线性 + HITL 循环 + 终结），非业务工作流。
> 源真相：`apps/server/src/workflows/synthetic.ts`。本文件为人类可读规格（衍生物，Q1）。

## 目标
跑通 s1 → review（HITL accept/redirect）→ s2，验证 append-only 日志 + 动态 `__next` 循环 + replay-free 两相 suspend。

## 输入
`{ offset?: number }`（缺省 0）。

## 步骤
1. **s1**（纯程序步）：产出 `{ value, offset }`。
2. **review**（HITL）：suspend 问 accept/redirect。
   - accept → 默认链 → s2。
   - redirect(+focus) → `__next:"s1"`、offset+1（循环携带新数据）。
3. **s2**（终结）：产出 `{ final }`。

## 输出
`{ final: string }`。

## 验证
见 `apps/server/test/workflow.engine.test.ts`（5 判据）。
