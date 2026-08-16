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

## M4 — 定时任务（✅ 全切片落地：#25-#27 骨架、#28 chat 建流、#29 执行链、#30 产出文件、#31 UI、#32 headless 挂载）

- [x] chat 说「每 4 小时去 xx 网站读新闻发摘要」→ LLM 任务卡（displayName + cron + 未来 3 次执行时间，参数暂存卡上零漂移）→ 用户确认（消息绑卡 inReplyTo）→ 入库（#28 + ADR-0022）
- [x] 频率下限强校验：API 层 422（相邻火点 <1h 拒；=1h 放行——票面示例勘误，按规则本体实现）
- [x] member 自建自批（API 面）：登录即可建、任务卡确认即建（卡片 UI 属切片 2/4）
- [x] CommandPolicy：deny 任务拒建（工具层 403）；require_approval 修订为自建自批（ADR-0021 修订版——任务卡卡主确认即建，不发 admin）
- [x] 到点执行（假钟测试）：产出落在产出会话（标题=displayName）、task_runs 收口（#29 真链 runTurn 同构；#32 system 分支 headless + note 日志）
- [x] 调度语义（假钟测试）：markFired 先推进再执行；missed 不补跑；skipped_overrun 同任务串行跨任务并行；重启恢复（DB 真相）
- [x] 任务执行走 runTurn 同构（enqueueEventTurn + 共享 per-conv FIFO）；任务 pi 无 bridge、tavily 保留（TASK_EXTENSIONS）
- [x] 产出文件（#30）：tool_use write/edit 收集 → task_files → 产出消息尾文件列表卡（文件管理器式）→ GET /files/<ws>/<path> 预览（md/txt/html/pdf + 顶部下载）auth 保护、防逃逸
- [x] system 任务（蒸馏 seed）：迁移幂等 seed、无产出会话、经 API 建被拒；未读数 unreadRuns + POST view 点开即清（管理页 UI 属切片 4）
- [x] 对话/管理改任务（API 面）：PATCH cron/prompt/displayName、cron 重算 nextFireAt（chat LLM 流属切片 2）
- [x] member 右侧面板「我的任务」看/停/删/手动跑自己的任务；admin 管理页 /admin/tasks 全量（member+system）+ 执行历史展开 + 未读 badge 点开即清（#31，e2e 两条流锁）
- [x] system 任务经 API 删/停/改 → member 403 硬拒（admin 可停/启/删、拒改内容）；chat LLM 侧同一服务端闸兜底
- [x] 手动调用：POST /:id/run 立即执行（trigger=manual、不推进 nextFireAt）、在跑 409
- [x] task_runs 历史：状态/trigger/起止/产出引用（GET /:id/runs；页面展开属切片 4）

## M5 — 学习闭环（2026-08-16 全链落地）

- [x] run 级反馈：批注+1-5 评分提交+回显（run 卡内；#34）
- [x] 消息级反馈：👍/👎+可选备注，点击即落库（rating 5/1）+刷新回显高亮（#34；反馈锚=align-db-ids 双源对齐回填的 DB id——pi entry id 与 DB id 两套标识对齐）
- [x] 权限：两粒度反馈按会话可见性（member 只见自己、admin 全通、不可见一律 404）；POST 放宽 text/rating 至少其一（#34）
- [x] knowledge repo：运行时独立 git 仓（DATA_DIR/knowledge；experience/global+members、skills 种子、learnings/、distill-state.json）；首启自动 init+首 commit（#35）
- [x] 注入通道：global 经验进每个 chat turn + 任务 turn（D1：任务不吃 member 级）；member 经验按会话归属注入 chat turn；member 文件无任何下载路由（#35）
- [x] 蒸馏链（#36）：语料前缀白名单 {chat-,run-}（排 title-/task-/distill- 防自指）；水位=已处理文件名集合+lastFeedbackId（pi 每 turn 一文件、mtime 不可靠——实测）；新 feedback 重入队关联会话文件；蒸馏 pi zero-extension 无 bridge；写回白名单（拒动作剔除留痕水位照推）；水位与写回同一 commit 原子；push best-effort；task_runs note 带 commit hash
- [x] 蒸馏 seed 启用：迁移 0015 enabled=1，周日 04:00；executeTask 按 t_seed_distill 特判走 runDistill（#37）
- [x] LLM 手写长 JSON 容错：字符串内裸控制字符转义+括号平衡截断（实测高频错法）；超长语料 prompt 走 stdin（argv E2BIG 实测）；坏输出原文落 DATA_DIR/distill-last-raw.txt 供诊断（#37）
- [x] 真实闭环冒烟（#37，真 LLM 全链）：👍+备注（feedback id=1）→ 手动蒸馏 run5 ok → git commit e8802a9（message=LLM 产）→ global.md 25 行经验落盘 + 水位 148 文件推进 → 新 turn 正常 → admin 任务页 note 可读 hash
- [x] 事后检查：git revert e8802a9 一条命令 → 水位随 revert 回退（148→0）、global.md 移除 → 下轮 run6 重蒸馏 ok（revert 语义=重读该批素材，人工可控）
