# Pi 子进程加载模型：skill 走标准发现、extension 走 `-ne` + 显式 `-e`

区分两类 Pi 资源（spike A 实测 + 源码核实 `dist/core/skills.js`、`dist/core/extensions/`）：

- **Skill（`SKILL.md`）**：Pi 有**标准发现**——自动扫 `<agentDir>/skills` + `<cwd>/.pi/skills` + `--skill`（skills.js:330-334）。模型看 skill 描述自己决定何时调用。
- **Extension（`.ts` + `registerTool`，即工具）**：**无目录式自动扫描**；只从 `pi install` 写入的 settings + 显式 `-e` + 包 `pi.extensions` 加载。`-ne` 关掉这个 discovery（显式 `-e` 仍生效）。

## 决策

- **Skill → 全量标准发现、不按工作流策展**：每次 pi 运行（闲聊 + 工作流）都能发现**全部** repo skills，Pi 自己判断何时调用哪个；**工作流定义不声明 skills**（`defineWorkflow` 无 `skills` 字段，只有 `extensions`）。机制：prod 沙箱 ro-bind `repo/skills → workspace/.pi/skills`（Pi 扫 `.pi/skills/`）；**dev 无沙箱用 `--skill <repo>/skills/<每个>`（`repoSkillPaths()` glob 全量）作过渡**——同样达到「全量发现」，沙箱上线后换 ro-bind、去掉 `--skill`。
- **Extension（工具）→ `-ne` + 显式 `-e`**：每次跑带 `-ne`（关掉 settings 里 pi-installed 扩展的 eager 加载），再 `-e` 显式加载该次所需工具扩展。**闲聊**加载「闲聊可用 skill 背后」的 vetted 工具扩展；**工作流**只加载其声明的。
- **绝不 `pi install` 到服务的 Pi 全局。**

## 原因（spike A 发现 A/B）

- **Finding A**：一个导出无效的 pi-installed **extension**（实测 `tavily-core.ts`）eager 加载时让**所有** pi 启动失败。`-ne` + 不全局 install 根治；显式 `-e` 只加载我们 vetted 的工具扩展。
- **skill 无此问题**：skill 是懒发现、模型按需调用，不会"加载失败阻断启动"——故 skill 直接用标准发现，不必策展（之前的"两模式策展 skill"想法已废弃）。
- **Finding B**：密钥相对 cwd 解析（`apiKey:"!grep .env"`）与「cwd=项目工作区」冲突 → 走**环境变量注入**（`--provider`/`--model`/`--api-key`），cwd 可任意（spike 已验证）。

## skill 如何可达（impl 细节，见 ADR-0006）

仓库 `skills/` 每次 pi 运行都要全量可达（标准发现）：
- **prod 沙箱**：bwrap `--ro-bind <repo>/skills <workspace>/.pi/skills`，Pi 扫 `.pi/skills/` 自动发现。
- **dev 无沙箱（当前）**：`runPi` 用 `repoSkillPaths()` glob `<repo>/skills/*/SKILL.md`，对每个 `--skill <path>`（全量、非按工作流策展）。沙箱上线后改 ro-bind、删 `--skill`。
- **不用 symlink**（会被 WORKDIR 清洗器拒，且是沙箱逃逸面）。

## 后果

- 扩展不再 `pi install` 全局；源码随仓库 `skills/<name>/extensions/`，运行时 `-e` 指向。
- 密钥经环境变量注入服务进程、透传 Pi 子进程；`.env` 仅 dev 本地。
- `models.json` 的 `apiKey` 改读环境变量，不再依赖 cwd 下 `.env`。
