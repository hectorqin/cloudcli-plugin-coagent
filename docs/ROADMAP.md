# CoAgent 下一阶段 ROADMAP（建议稿）

> 由 coagent 自身产出：run `r-ae2a82`，lead `lead-a570`（Claude）委派 planner `planner-6d87`（Codex，只读）。
> lead 复核：抽查 worker 名额语义（`broker.ts` ACTIVE_WORKER 含 idle/reported）、投递前置标记、`/setup` 无 token、`.coagent/` 未实现等结论属实；DESIGN.md 中被指出的过时表述已同步修正。

> 调研日期：2026-11-25。只读审计，未修改任何文件。已运行 `npm test -- --run`（4 个测试文件、45/45 通过）与 `npm run typecheck`（通过）；核对 fork 最近提交为 `cc76a24c`（worktree 归组）、`fbc1e9b9`（toolRenderers）、`8c3e57f1`（1.37.10-coagent.1）。

## 一、当前状态判断

### 已验证

- 核心 plugin-only 链路已有较强证据：设计记录的真实 E2E 已覆盖 Claude lead → 计划审批 → Claude coder 独立 worktree → 结果 → 合并审批/合并 → Codex reviewer（`docs/DESIGN.md §5.2`，尤其 81–84 行）；另有 Claude lead 在一轮中完成 inline gate、spawn、wait、merge 的实测（§12，154–159 行）。
- 身份链路已落到代码：Claude 取 `CLAUDE_CODE_SESSION_ID`，Codex 优先取每次请求的 `x-codex-turn-metadata.thread_id`（`src/shim/mcp-shim.ts:21-31`）；worker 首次 TOFU 绑定后会拒绝不同 session 冒用（`src/broker/broker.ts:251-280`），相关测试在 `test/units.test.ts:33-48`、`test/broker.test.ts:109-159`。
- 状态主体确实持久化到 SQLite/WAL：runs、agents、messages、gates、events、kv（`src/broker/store.ts:9-69,85-99`）；计划、投递重试、worktree、合并冲突、wait 聚合、inline gate 均有单元/集成测试（`test/broker.test.ts:161-429`）。
- broker 仅监听 loopback，shim 使用每次启动随机 token，runtime 文件以 0600 写入（`src/broker/server.ts:34,60-62,120-124`）；API key 比较使用 timing-safe compare（`src/broker/cloudcli.ts:78-86`）。
- 时间线和工具卡已有纯函数测试（`test/timeline.test.ts:33-65`、`test/toolCards.test.ts:25-59`）。fork 两个 patch 各自带服务端/前端测试，且提交拆分清楚。
- 已安装 CloudCLI 的 `POST /api/agent` 已支持 app/provider session 续写和 409 busy 注册（`agent.routes.ts:919-938,994-1017`），也会流出标准化 `token_budget`；这为恢复与 token 可见性提供了数据源。

### 尚未验证

- fork 包虽已构建，但尚未安装；因此真实 UI 的 worktree 归组、插件工具卡加载/更新/fallback、Open 按钮均未验证。设计也明确承认这一点（`docs/DESIGN.md:160`）。
- UI 创建的正常会话升级为 lead 仅有同路径源码推断，真实浏览器未测（`docs/DESIGN.md:84,125`）。
- Codex lead 完整流程未测；Codex 没有 CloudCLI elicitation bridge，只能走异步 tab gate（`src/shim/mcp-shim.ts:212-216`；`docs/DESIGN.md:154,160`）。
- broker 重启、broker 在 worker turn 中崩溃、CloudCLI/worker 异常退出、网络/SSE 半断开均没有恢复测试。
- 同一 repo 多 run 并发、同一 lead working tree 并发 merge、远程 PR 流程、真实 URL 安装/升级/卸载均未测。
- 当前仓库没有任何 commit（所有文件均为 untracked），因此 README 所说的“从 git URL 安装”目前不可交付。

### 已知缺陷与风险

1. **权限是发布阻断项。** coagent 请求只传 `unattended:false`（`src/broker/cloudcli.ts:108-125`）；已安装 CloudCLI 对 Claude/Codex 仍硬编码 `bypassPermissions`（`agent.routes.ts:1055-1068,1080-1090`）。这不只是 worker，broker 唤醒 lead 的轮次也绕过权限（`docs/DESIGN.md:63,68`；`README.md:43-48`）。
2. **重启会产生不一致。** `busy`、activity 在内存（`src/broker/store.ts:85-91`），backoff、lease、waiting、inflight 也在内存（`src/broker/broker.ts:61-68`）。消息在 HTTP turn 成功前先标 delivered（`broker.ts:420-435`）；若进程在标记后、回调重置前崩溃，消息可能永久丢失。初次 spawn 也先标任务消息 delivered 再异步发 turn（`broker.ts:157-165`），崩溃会留下永久 `starting`。
3. **没有 merge 前 diff gate。** 当前批准后才 `commitAll`，随后直接 merge（`broker.ts:330-350`）；gate 只保存 note/summary（`broker.ts:205-213`）。用户无法确认具体 patch，且请求 gate 到批准之间 worker/lead HEAD 可能变化。
4. **多 run 同 repo 无锁。** merge 对 lead cwd 直接操作（`src/broker/git.ts:43-55`），没有 repo/working-tree mutex；并发批准可能互相干扰。agent id 仅 `role + 2-byte random`，且 agents.id 是全局主键、branch 也不带 run id（`broker.ts:149`；`store.ts:19-35`），长期使用存在碰撞/残留分支问题。
5. **“成本”数据语义易误导。** broker 当前只把 text/tool activity 留在内存，忽略 `token_budget`（`broker.ts:24-39,519-525`）。CloudCLI 的 token_budget 主要是上下文窗口快照，不必然等于可计费累计成本；订阅制 Claude/Codex 更不能可靠换算美元。
6. **安全边界仍是同一 Unix 用户。** loopback + 0600 足以防远程/其他用户，但同用户进程可读 token/API key。已有 DATA_DIR 只在新建时请求 0700，既有目录未 chmod（`server.ts:26`）；首次 `/setup` 在“尚无 key”时无需 broker token（`server.ts:65-72`），应评估 localhost CSRF/恶意本地网页触发。
7. **版本/发布元数据不一致。** `package.json` 是 0.1.0 且 `private:true`，`manifest.json:4` 与 shim server（`mcp-shim.ts:203`）是 0.2.0。
8. **worker 容量语义会卡流水线。** `idle` 和 `reported` 都算 active（`broker.ts:17,145-148`），而只读 worker 无 merge/结束单 agent 的路径；跑过 4 个尚未 end-run 的 worker 后不能继续派新 worker。
9. **可观测性过弱。** 日志只是 stderr 文本（`server.ts:24`），无 level、run/agent/turn correlation、持久化、健康/诊断导出；失败排查依赖 DB 和 systemd 日志手工拼接。

### DESIGN.md/README 中应纠正的事实

- `docs/DESIGN.md:3` 仍写“待 spike”，但 §8 已有结果且实现/E2E 已完成。
- `docs/DESIGN.md:37` 把 runtime 写成插件目录；实际是 `~/.cloudcli-coagent/runtime.json`（`src/broker/paths.ts:7-11`）。
- §4.2 声称单向导出项目 `.coagent/`（43 行），代码没有导出器或相关存储路径。
- §4.3 仍声称“任务看板”（57 行），实际 UI 是 messages/events 驱动的泳道时间线，没有 task/DAG 实体。
- §7（95–106 行）仍是已被 §5.1 推翻的 pnpm monorepo/better-sqlite3/空 patches/软链结构，应删除或改为现状。
- README 第 5 行“No CloudCLI patches”只对基础 tab 工作流成立；实时工具卡依赖尚未上游的 patch 2，worktree 归组依赖 patch 1（`README.md:24-27`、`manifest.json:13-15`）。建议明确“核心可零 patch，增强 UI 需 fork/待上游”。
- §1 的“v1 零 patch”与 §10/§12 并非完全冲突，但表述会让发布用户误判增强能力是否可用。

## 二、候选方向（12 项）

### 1. Worker/代理轮次权限模型（P0）

- **用户价值：** 消除当前最大安全风险，让 worker 和 broker 唤醒的 lead 不再默认全权限。
- **实现：** 给 CloudCLI `/api/agent` 增加经过 allowlist 校验的 `permissionMode`（并统一映射 Claude/Codex/OpenCode/Cursor 能力）；coagent 按 run/角色保存策略，默认 writer=`default`/需审批、readonly=只读沙箱（若 provider 支持），显式高风险开关才 bypass。权限请求继续进入该原生 session UI，并在 coagent 卡片显示“awaiting approval/Open”。
- **边界：** 必须 fork patch，通用且高度 upstreamable；plugin 只消费该参数。
- **工作量：** M。
- **风险：** provider 模式不等价；无人打开 worker session 时可能悬停；不能把“默认模式”误写成真正 OS 沙箱。
- **验证：** CloudCLI route/provider 单测覆盖非法值与每 provider 映射；真实 Claude/Codex worker 分别触发文件写/命令审批，确认对应 session 可批准、拒绝后 worker不继续；确认 lead 的 broker-delivered turn 也不 bypass。

### 2. Broker 重启与 crash recovery（P0）

- **用户价值：** systemd 重启或插件升级后任务不丢、不永久卡 running。
- **实现：** messages 增加 `queued/dispatching/acked`、attempt、lease_until、delivery_id；turns 表记录 start/end/error/provider run id；启动时把过期 dispatch lease 回队并把 stale starting/running 标为 `interrupted/unknown`，通知 lead 决定“重试/认领现有 session/结束”。spawn 的 worktree+DB+dispatch 做补偿事务；activity 写入有界 event/turn_activity。对无法判定是否已被模型执行的 turn采用显式“可能重复”而不是盲目重放。
- **边界：** plugin-only。
- **工作量：** L。
- **风险：** 外部 side effect 无法 exactly-once；DB migration/老数据兼容；CloudCLI 缺少查询 run 状态 API。
- **验证：** 在“标 delivered 后”“SSE 中途”“worker 已完成但 report 前”故障注入 kill broker，重启检查无静默丢信、无自动重复 merge；migration 与恢复状态单测、systemd E2E。

### 3. Merge 前结构化 diff review（P0）

- **用户价值：** 合并门真正审的是代码，不是 worker 自报摘要。
- **实现：** `request_merge` 时要求 worker 非 busy，先 commit leftovers，记录 worker HEAD、lead HEAD、merge-base、name-status/stat、限长 patch/binary 标记到 gate snapshot；tab/工具卡展示文件列表和 diff。批准时校验两端 HEAD 未变化，变化则 gate 过期并要求重开；再执行 merge。
- **边界：** plugin-only；若希望复用 CloudCLI 原生 Diff 组件，可另提小型 tool-renderer host API patch，但非必需。
- **工作量：** M。
- **风险：** 大 diff/二进制/敏感文件、commitAll 改变 worker 状态、lead 工作树漂移。
- **验证：** clean/dirty/binary/超大 patch、HEAD 漂移、冲突、拒绝均测试；真实 UI 审完具体文件后 merge，合并 commit 与 snapshot SHA 一致。

### 4. Codex lead parity 与真实 UI 验收（P0/P1）

- **用户价值：** Codex lead 不再是二等流程；增强卡片从“代码存在”变为可依赖功能。
- **实现：** 先安装 fork 做 Claude/Codex 浏览器矩阵；plugin-only 地在 tool card 中加入 plan/merge approve/reject/comment 按钮（复用 host.rpc），Codex 仍用异步 gate + wait/下一轮通知。完整同轮阻塞式 parity 需 CloudCLI/Codex MCP elicitation bridge，单独 upstream spike，不与 v0.3 核心绑定。
- **边界：** 卡片动作依赖 patch 2（通用、upstreamable）；真正 Codex elicitation 是另一 fork patch，是否可上游取决于 Codex app-server 协议能力。
- **工作量：** M（异步 parity）/L（elicitation）。
- **风险：** tool card 生命周期、表单与 tab 竞态、Codex 客户端能力可能根本不暴露 elicitation。
- **验证：** 真实浏览器测试 Claude/Codex × tab/card 决策 × approve/reject × 并发先到先得；renderer 加载失败必须回退原生行。

### 5. Token/耗时/成本可见性（P1）

- **用户价值：** 知道哪个 worker 消耗最多，能设预算并发现失控任务。
- **实现：** 捕获 SSE `token_budget`、turn 时长、provider/model，持久化每 turn 最新上下文 usage；run/agent 汇总 input/output/cache（只有语义可靠时累加），UI 明确区分“上下文占用”“本轮 token”“估算成本”。美元仅在用户选定价格表且 provider 给出可计费用量时显示；支持软预算告警/停止继续派活。
- **边界：** plugin-only；若需要精确账单事件，可提上游标准 usage event PR。
- **工作量：** M。
- **风险：** snapshot 当累计值导致重复计算；模型价格变化；订阅账号无真实边际美元成本。
- **验证：** 用固定 SSE fixture 验证去重/跨 turn；与 CloudCLI session token UI 对照 Claude/Codex；明确显示 unknown 而非 0。

### 6. Task DAG / Cline 风格 Kanban（P1/P2）

- **用户价值：** 显式表达 planner→coder→reviewer/tester 的依赖，前置任务完成后可自动解锁，run 不再只是一串消息。
- **实现：** 新增 tasks、task_dependencies、task_attempts；task 与 agent 解耦，一任务可返工多 attempt；状态 `blocked/ready/running/review/done/failed`；lead 的 plan 可提交结构化 task spec，tab 提供 Kanban + DAG，broker 只在所有依赖满足且 gate 策略允许时派活。
- **边界：** plugin-only。
- **工作量：** L。
- **风险：** 让 broker 自动 spawn 会与“模型是编排者”冲突；循环依赖、失败传播、UI 复杂度。
- **验证：** DAG 环检测、fan-out/fan-in、失败/重试/取消；E2E 验证 planner 完成后仅解锁指定 coder。建议 v0.3 只定义 schema/UX，不实现自动编排。

### 7. PR 创建替代本地 merge（P1/P2）

- **用户价值：** 保留 CI、代码审查、分支保护和远程审计，符合成熟仓库习惯。
- **实现：** run 级 mergeStrategy=`local|pull_request`；snapshot 后 push `coagent/<run>/<task>`，用 `gh` 或 GitHub API 创建 PR，存 remote/PR URL/head SHA；gate 语义变为“批准发布 PR”或“批准合并 PR”，默认不自动远程 merge。复用 CloudCLI 已有 Agent API PR 逻辑前先抽成通用服务，避免 coagent 调 `/api/agent` 再跑一个模型 turn。
- **边界：** 可 plugin-only（`gh`/token），但凭据复用最好做通用 upstream API；不应把 GitHub-only逻辑塞入核心。
- **工作量：** L。
- **风险：** token scope、fork remote、非 GitHub、分支保护、重复 PR。
- **验证：** 临时 GitHub repo：创建/幂等重试/无权限/已有分支/CI failure；本地 merge 回归。

### 8. 同 repo 多 run 并发（P1）

- **用户价值：** 多个 lead 可以安全同时协作，不互相覆盖或合并错分支。
- **实现：** id/branch/worktree 全部带 run id；新增 repo identity（realpath + git common-dir）和 repo operation mutex/DB lease；merge 以记录的目标 ref/SHA 为准，不以“当前 cwd 恰好 checkout 什么”为准；检测同一 worktree 被两个 active lead 使用，默认禁止并发本地 merge，建议 PR 模式。
- **边界：** plugin-only。
- **工作量：** M/L。
- **风险：** 多进程 broker、symlink/case normalization、用户手动 checkout、锁遗留。
- **验证：** 两 run 同 repo 并行 spawn/report/approve，刻意同时点 merge；确保串行、SHA 校验、无错误分支；branch collision 测试。

### 9. 发布、安装与升级（P0）

- **用户价值：** 能真正从 URL 安装、可复现构建、可回滚。
- **实现：** 先建立 git 历史并打 `v0.3.0`；统一 package/manifest/shim 版本；补 LICENSE、CHANGELOG、兼容 CloudCLI 版本矩阵、release artifact/checksum；CI 跑 test/typecheck/build、干净 checkout 安装、manifest 校验。真实 git URL 安装/升级/卸载测试，迁移 DB 前自动备份。fork 包另发明确后缀，不能假装上游兼容。
- **边界：** plugin-only 发布工作；fork artifact 独立。
- **工作量：** M。
- **风险：** CloudCLI 安装时执行依赖脚本、Node 版本、用户级 MCP 注册副作用、升级期间 broker 重启。
- **验证：** 新用户目录 + 干净 CloudCLI，从 URL 安装→配置→跑 smoke→升级→保留 DB→卸载/注销 MCP。

### 10. Broker/shim 安全加固（P0/P1）

- **用户价值：** 降低本机网页/其他进程滥用 broker、凭据泄露与路径越界风险。
- **实现：** 启动时 chmod DATA_DIR 0700、runtime 0600并校验 owner；runtime 加 instance id/protocol version/过期时间；所有 body 设大小限制、Origin/Host 检查与统一 auth；首次 setup 使用一次性 nonce（由 tab 经 CloudCLI proxy 获取）或要求插件代理证明，避免裸 localhost mutation；敏感日志脱敏。明确威胁模型：不承诺抵御同 Unix 用户。
- **边界：** plugin-only；CloudCLI plugin proxy 若能提供签名身份，可提 upstream 小 PR。
- **工作量：** S/M。
- **风险：** 过严 Origin 会破坏代理；token 轮换导致旧 shim 调用短暂失败。
- **验证：** 非 loopback、错 token、超大 JSON、恶意 Origin、旧 runtime、权限错误文件；正常 tab/shim 回归。

### 11. 可观测性与诊断（P1）

- **用户价值：** 出错时能回答“哪个 run/turn/投递失败、重试了几次、卡在哪里”。
- **实现：** JSON structured log（level、runId、agentId、turnId、deliveryId、latency、status，绝不含 prompt/API key）；持久化 turn/delivery 状态；tab diagnostics/health（broker version、DB schema、registration、CloudCLI reachability、stale agents）；导出脱敏 support bundle。
- **边界：** plugin-only；CloudCLI 若提供插件日志 UI 可后续 upstream。
- **工作量：** M。
- **风险：** prompt/路径泄密、日志膨胀；需 retention。
- **验证：** 故障场景能用一个 correlation id 串起；脱敏测试与轮转/上限测试。

### 12. Upstream PR 策略（持续项）

- **用户价值：** 最小化长期 fork，通用能力被上游维护。
- **路径与顺序：**
  1. **先 permissionMode PR**：安全、范围独立、route/provider 测试清晰。
  2. **再 patch 1 worktree grouping**：通用 UX；先 rebase 最新上游，补 Windows/path/symlink 与 archived parent 行为说明。
  3. **再 patch 2 toolRenderers**：先写扩展 API 文档、生命周期/安全模型、版本兼容、fallback；这是较大的公共 API，单独评审。
  4. Codex elicitation bridge先 spike 后决定是否 PR。
  5. REST steer、session event subscription、按 run MCP/env 注入继续保留后续，不应阻塞 v0.3。
- **边界：** fork patches，全部目标 upstream；每个 PR 一项能力，不把 coagent 品牌/业务逻辑带入。
- **工作量：** M（前三项整理/评审，不含上游等待）。
- **风险：** 当前两 patch 基于 1.37.10；上游漂移、API 设计被要求重做。
- **验证：** 每个 commit 在 clean upstream 单独 cherry-pick/build/test；coagent 分别在 vanilla、仅 patch1、仅 patch2、全 patch 矩阵 smoke。

## 三、推荐优先级与 v0.3

### 推荐顺序

1. **先立发布基线：** 首次 commit、版本统一、CI、真实 URL 安装 smoke（方向 9）。
2. **安全止血：** permissionMode 上游 patch/PR + broker 安全小项（1、10）。
3. **可信合并：** diff snapshot + SHA 防漂移（3）。
4. **可靠运行：** recovery/delivery 状态机第一阶段 + structured logging（2、11）。
5. **真实 UI 矩阵：** 安装 fork，验 tool cards/worktree grouping/Codex 异步流程（4）。
6. **token 可见性与 repo 并发锁**（5、8）。
7. **上游提交 patch 1/2**（12；permission PR应更早）。
8. **v0.4+：** DAG/Kanban、PR workflow、完整 Codex elicitation（6、7、4-L）。

### v0.3 建议范围

**In scope**

- 可发布 git 仓库：统一 0.3.0、CI、CHANGELOG/LICENSE、URL 安装/升级 smoke。
- CloudCLI permissionMode 最小 patch + upstream PR；coagent 默认安全策略，UI 明示当前模式。若上游未合并，fork 版本提供；vanilla CloudCLI 上必须醒目阻断/二次确认 bypass，而非静默继续。
- merge gate 保存 commit 后的 diff snapshot + worker/lead SHA；tab 展示文件/stat/限长 patch；SHA 漂移自动使 gate 失效。
- recovery v1：持久化 delivery/turn attempt、启动时发现 stale running/starting、无静默丢消息、人工可重试；不承诺 exactly-once side effect。
- JSON 日志与 diagnostics；目录/文件权限、请求大小、setup nonce/代理鉴权加固。
- 捕获并展示“上下文/token usage + turn duration”，不承诺美元成本。
- repo 级 merge mutex、run-scoped branch/worktree/id。
- 安装 fork 后完成真实浏览器矩阵：Claude lead、Codex lead异步 gate、tool card fallback/live update/Open、worktree sidebar grouping。

**Out of scope**

- 自动 DAG 调度/Kanban 完整实现。
- 自动创建/合并远程 PR。
- Codex 原生 elicitation 同轮表单（先 spike）。
- 精确美元账单、所有 provider 扩展、同屏完整 worker 流式 transcript。
- exactly-once agent side effects；只能做到可检测、可恢复、明确提示潜在重复。

### v0.3 Definition of Done

- 干净机器/用户目录可从 git URL 安装 0.3.0，升级保留 DB，卸载能安全注销 MCP；CI 全绿。
- Claude、Codex 各完成一次 lead→worker→review→diff approval→merge；真实 UI 中 tab 与工具卡均验收。
- 默认 worker 不再 silent bypass；写/命令需要的权限可在对应 session 明确批准/拒绝。若运行在未打权限 patch 的宿主，产品明确阻断或要求一次显式风险确认。
- 在 dispatch 前后、SSE 中途 kill broker 三组测试中，重启后无消息静默丢失、无自动重复 merge，stale 状态可见且可处理。
- 合并内容与 gate 展示的 SHA/diff 一致；任一 HEAD 漂移都会阻止合并。
- 同 repo 两 run 并发不会同时操作同一 target worktree；所有日志可按 run/agent/turn 关联且无 key/prompt 泄漏。
- vanilla CloudCLI 仍可使用基础 tab 工作流；增强功能和所需 patch/宿主版本在 README 中准确标明。

## 四、需要用户决定的问题（含建议）

1. **v0.3 是否允许在未打 permissionMode patch 的 vanilla CloudCLI 上启动 writer？**  
   建议：默认禁止 writer；用户在设置中逐次明确接受“bypass + 非沙箱”风险后才允许。read-only 也不能声称真正隔离。
2. **权限审批显示在哪里？**  
   建议：权限仍归 worker 原生 session（保证 harness 语义），lead 卡片显示等待状态和 Open 链接；不要由 broker伪造/代批权限。
3. **v0.3 的默认交付是 vanilla plugin 还是配套 fork？**  
   建议：发布一个 plugin，声明 vanilla 基础模式；同时提供可选、版本锁定的 fork 包用于工具卡/侧栏/安全 permissionMode，直到 PR 上游。
4. **merge gate 是否可自动 commit worker 未提交内容？**  
   建议：可以，但在“打开 gate”时 commit，并展示生成 commit/SHA；批准时绝不再静默改内容。
5. **默认 merge 策略？**  
   建议：v0.3 保持 local `--no-ff`，但加 repo 锁和 diff/SHA gate；v0.4 增加 PR-first，发布型仓库默认 PR。
6. **成本展示口径？**  
   建议：v0.3 只显示 tokens/context/duration；美元标“估算”且默认关闭，绝不把上下文快照当账单。
7. **任务自动化程度？**  
   建议：下一阶段先做显式 task/DAG 数据模型与手动解锁，不让 broker 自动替 lead spawn；有真实使用反馈后再加自动触发。
8. **保留期与隐私？**  
   建议：业务 DB 默认保留直到用户结束/清理；activity/log 默认 7 天或有界条数，support bundle 默认不含 prompt、diff正文、绝对路径和凭据。
9. **同 repo 多 run 的默认策略？**  
   建议：允许并行 worker worktree，但同 target branch 的本地 merge串行且做 SHA 校验；检测同一 lead working tree 时给出强提示，PR 模式成熟后优先推荐 PR。
10. **上游 PR 是否立即开始？**  
    建议：是；先 permissionMode，随后 patch 1，再 patch 2。每个 PR 独立、通用、带测试和文档，不等待 v0.3 全部完成。

## 文件变更与遗留

- 文件变更：无（严格只读）。
- 已验证：45/45 测试通过；TypeScript typecheck 通过；fork commit/patch 与已安装 CloudCLI Agent API 源码已核对。
- 遗留：真实浏览器/fork 安装、Codex lead E2E、crash recovery、并发与 URL 安装均尚未执行，应按上述 v0.3 DoD 补齐。

## 五、用户决定（2026-11-25）

| # | 问题 | 决定 |
|---|---|---|
| 1 | vanilla CloudCLI（无 permissionMode patch）上是否允许 writer | **做成开关**：默认禁止，tab 设置中可显式开启（开启时明示 bypass + 非沙箱风险） |
| 2 | 权限审批显示位置 | 推荐：归 worker 原生 session，lead 卡片显示等待状态与 Open |
| 3 | v0.3 交付形态 | 推荐：plugin（vanilla 基础模式）+ 版本锁定的配套 fork 包 |
| 4 | merge gate 自动 commit | 推荐：打开 gate 时 commit 并展示 SHA，批准时不再改内容 |
| 5 | 默认 merge 策略 | 推荐：v0.3 本地 `--no-ff` + repo 锁 + diff/SHA gate；v0.4 PR-first |
| 6 | 成本口径 | 推荐：只显示 tokens/context/duration，美元默认关闭 |
| 7 | 任务自动化 | 推荐：先做显式 task 数据模型与手动解锁 |
| 8 | 保留期与隐私 | 推荐：activity/log 有界保留，support bundle 默认脱敏 |
| 9 | 同 repo 多 run | 推荐：worker 并行，同 target 本地 merge 串行 + SHA 校验 |
| 10 | 上游 PR 时机 | **v0.3 完成后一起提**（permissionMode、worktree 归组、toolRenderers） |

## 六、进度

- **v0.3 第一波（2026-11-25，run `r-8038eb`）已合并到 main**：
  - 可靠性 v1：投递状态机、会话感知的重启恢复、`end_agent`、名额修正、run 作用域 id（coder-55f7 / Claude；Codex reviewer 6 项问题已修）
  - 合并关卡 diff 快照 + SHA 校验 + repo 锁（coder-3fb7 / Codex；Claude reviewer 8 项问题已修）
  - 安全加固 + 结构化日志 + 诊断面板（coder-efdf / Codex；Claude reviewer 6 项问题已修）
  - fork patch 3：`/api/agent` `permissionMode`、`GET /api/agent/capabilities`、`GET /api/agent/sessions/:id`（安装包 `1.37.10-coagent.2`）
- **第二波待做**：插件权限策略开关（消费 patch 3）、token/耗时可见性、真实 UI 验收矩阵、发布（CI、URL 安装）。
