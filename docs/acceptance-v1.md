# v1 验收清单

随里程碑切片验收逐项生长（PRD §6）；GA 冒烟（两工作流串联+反馈+经验沉淀）以此为底。
打勾=已验收（附证据 commit/issue）。

## M2 — 执行面（已验收 2026-08-15，#9-21 关闭）

- [x] chat 说「跑合成三步」→ pi 调 start_workflow → run 卡 + step 进度实时（web E2E workflow.spec）
- [x] run 挂起 → ask_user 选项卡 → 点选续跑 → run_completed + 自动总结（web E2E workflow.spec）
- [x] 刷新页面：已答提问只剩答案、未答仍在（web E2E workflow.spec）
- [x] ask_user 待答期间可聊别的（后端 hitl.test + e2e）
- [x] require_approval 工作流：审批卡只人类可批、LLM 无自批路径（approvals.test）
- [x] abort：杀 turn + 停 run（e2e abort.spec）
- [x] 后端 224 测试绿（2026-08-15；compaction.real-pi 环境性失败除外，与代码无关实证）

## M3 — bwrap/Linux + Docker（已验收 2026-08-15，048bfb5，#3 关）

- [x] Linux 容器内 containment 5/5：.env 拒 / DB 拒 / 工作区 rw / skills ro / symlink 逃逸阻断（test/sandbox-bwrap.test.ts）
- [x] 实修 bwrap 两 bug（~/.pi/agent bind 崩溃、相对 argv[0] 的 `--ro-bind . .`）
- [x] Docker 镜像构建 + 容器冒烟：boot → /health → login → 建会话（ws_company seed）
- [x] darwin Seatbelt 零回归
- [ ] 网络对等（pasta netns：loopback 拒+bridge 窄放行）——拆 #22，需原生 Linux（v1 GA 前收口）

## M4 — 定时任务（待实现）

- [ ] chat 说「每 4 小时去 xx 网站读新闻发摘要」→ LLM 任务卡（cron 人类可读 + 未来 3 次执行时间）→ 用户确认 → 入库
- [ ] 频率下限强校验：LLM 错解成 <1h 间隔 → 服务端拒（任务卡前）
- [ ] member 自建自批：任务卡确认即建，无 admin 参与
- [ ] CommandPolicy：deny 任务拒建；require_approval 任务发审批卡给 admin，批后入库
- [ ] 到点执行（测试可控时钟）：产出出现在产出会话，含目标摘要
- [ ] 产出会话挂任务同 ws；多次执行产出累积可回看
- [ ] 对话改任务：「改成每 2 小时」→ LLM 定位旧任务 → 新任务卡确认 → 生效
- [ ] member 在右侧面板看/停/删自己的任务；admin 管理页管全部任务
- [ ] system 任务（蒸馏 seed）经 chat 删/停 → 硬拒；admin UI 可管
- [ ] 手动调用：admin 页按钮 → 立即执行一次 → 历史出现记录
- [ ] missed：停机跨窗口 → 记 missed 行不补跑；数据留下次（蒸馏场景）
- [ ] skipped_overrun：上轮未完 → 跳过记录
- [ ] task_runs 历史：状态/耗时/产出引用，页面展开可见
- [ ] 调度器重启恢复：服务重启后任务仍在（DB 真相）、错过窗口记 missed

## M5 — 学习闭环（待实现）

- [ ] run 级反馈：批注+评分提交
- [ ] 消息级反馈：👍/👎+可选备注
- [ ] 蒸馏（每周 seed 任务）：读当周反馈+pi session 切片 → 蒸馏 → 服务端白名单校验写回 experience.md + learnings/ + git 自动 commit
- [ ] 事后检查：git diff 可见每次蒸馏变更；revert 一条命令
- [ ] 只蒸馏有反馈关联的执行（无反馈不进）
