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

## M4 — 定时任务（骨架 ✅ #25/#26/#27 @ 01293dd/1cd5d52/316911c；切片 2-5 待实现）

- [ ] chat 说「每 4 小时去 xx 网站读新闻发摘要」→ LLM 任务卡（display_name + cron 人类可读 + 未来 3 次执行时间）→ 用户确认 → 入库
- [x] 频率下限强校验：API 层 422（相邻火点 <1h 拒；=1h 放行——票面示例勘误，按规则本体实现）
- [x] member 自建自批（API 面）：登录即可建、任务卡确认即建（卡片 UI 属切片 2/4）
- [ ] CommandPolicy：deny 任务拒建；require_approval 任务发审批卡给 admin，批后入库
- [ ] 到点执行（clock 注入假钟测试）：产出出现在产出会话（标题=display_name），含目标摘要（执行 stub 待切片 3 替换）
- [x] 调度语义（假钟测试）：markFired 先推进再执行；missed 不补跑；skipped_overrun 同任务串行跨任务并行；重启恢复（DB 真相）
- [ ] 任务执行走 runTurn 同构（enqueueEventTurn）；任务 pi 无 bridge（无交互工具）、tavily 保留
- [ ] 产出文件：任务写了文件（tool_use 记录收集）→ 产出消息带下载链接 → 登录态浏览器可打开（auth 保护）
- [x] system 任务（蒸馏 seed）：迁移幂等 seed、无产出会话、经 API 建被拒；未读数 unreadRuns + POST view 点开即清（管理页 UI 属切片 4）
- [x] 对话/管理改任务（API 面）：PATCH cron/prompt/displayName、cron 重算 nextFireAt（chat LLM 流属切片 2）
- [ ] member 在右侧面板看/停/删自己的任务；admin 管理页管全部任务（UI 切片 4）
- [x] system 任务经 API 删/停/改 → member 403 硬拒（admin 可停/启/删、拒改内容）；chat LLM 侧同一服务端闸兜底
- [x] 手动调用：POST /:id/run 立即执行（trigger=manual、不推进 nextFireAt）、在跑 409
- [x] task_runs 历史：状态/trigger/起止/产出引用（GET /:id/runs；页面展开属切片 4）

## M5 — 学习闭环（待实现）

- [ ] run 级反馈：批注+评分提交
- [ ] 消息级反馈：👍/👎+可选备注
- [ ] 蒸馏（每周 seed 任务）：读当周反馈+pi session 切片 → 蒸馏 → 服务端白名单校验写回 experience.md + learnings/ + git 自动 commit
- [ ] 事后检查：git diff 可见每次蒸馏变更；revert 一条命令
- [ ] 只蒸馏有反馈关联的执行（无反馈不进）
