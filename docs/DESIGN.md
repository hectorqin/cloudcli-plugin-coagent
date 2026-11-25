# CloudCLI CoAgent — v1 设计

> 状态：v0.2 已实现并经真实 CloudCLI 端到端验证（2026-11-25）。§1–§8 是最初决定，后续修正见 §5.1、§9–§12；下一阶段见 `docs/ROADMAP.md`。
> 目标宿主：`@cloudcli-ai/cloudcli` v1.37.10（AGPL-3.0）；增强 UI 依赖 fork 补丁（§10、§12）。

## 1. 定位

- CloudCLI **纯插件**实现多 agent 协作，v1 **零 patch**。
- 自用起步，按可公开发布的质量写。
- fork 仅用于验证通用扩展点，目标是以 PR 回上游，最终不维护 fork。

## 2. 协作模型

- **编排式 + 跨 provider**：1 个 lead + ≤4 个 worker；仅 lead 可 `spawn_agent`（深度 1）。
- provider：v1 支持 Claude、Codex；之后扩展到全部（cursor、opencode…）。
- `spawn_agent(role, task, provider?)`：未指定 provider 时按「角色 → provider」默认映射（tab 中可配），默认保证写与审由不同模型承担。
- 角色预设：planner / coder / reviewer / tester；另有「流水线模板」= 预设角色序列。
- 协议通过 MCP 工具描述 + 首条 prompt 模板（lead / worker / 各角色）注入，模板为 `prompts/*.md`，可改。

## 3. 发起与身份

- **会话内自动升级**：任意会话调用 `spawn_agent` → broker 识别调用方 → 若不在任何协作中，则创建协作并将其设为 lead，tool result 返回 lead 协议。
- 由此产生的 lead 是用户正常交互的会话，**权限审批照常**。
- 身份识别（spike 已验证，均为 provider session id，不可由 agent 伪造）：
  - Claude：MCP 进程继承环境变量 `CLAUDE_CODE_SESSION_ID`。
  - Codex：MCP 子进程环境被清空（无 `CODEX_*`），但每个 `tools/call` 的 `params._meta["x-codex-turn-metadata"]` 携带 `thread_id` / `turn_id`（`params._meta.threadId` 亦有）。shim 按 provider 从对应来源取 id。
  - 兜底：agent 自报 `agent_id`（仅当以上都缺失）。
- `/api/agent` 的 `sessionId` 参数接受 provider session id（`getSessionByProviderSessionId`）。
- app session id ↔ provider session id：插件 tab 的 `api.context.session.id` 是 **app id**，MCP 拿到的是 **provider id**。broker 以只读方式查询 `~/.cloudcli/auth.db` 的 `sessions(session_id, provider_session_id, provider)` 做映射，并关注 `superseded_provider_sessions`（provider id 可能被替换）。

## 4. 组件

### 4.1 `mcp-shim/`（stdio MCP）

- 注册到用户级 `~/.claude.json`（`mcpServers`）与 `~/.codex/config.toml`（`mcp_servers`）；broker 启动时幂等写入，提供开关。
  - Codex 条目必须带 `default_tools_approval_mode = "approve"`：否则 MCP 工具调用需审批，在非交互（`approval_policy=never`）的 worker 中直接失败（spike 实测）。
- 启动后读取 `~/.cloudcli-coagent/runtime.json`（端口 + 本地 token）转发给 broker。
- 工具：`spawn_agent`、`send_message`、`read_inbox`、`report_result`、`submit_plan`、`request_merge`、`list_agents`。
- 非协作会话调用时返回「未加入协作」（`spawn_agent` 除外，它触发升级）。

### 4.2 `plugin/` 后端 = broker

- 状态：插件自有 SQLite（`~/.cloudcli-coagent/coagent.db`）为唯一事实源。原定的 `.coagent/` markdown 导出**未实现**。
- 派活 / 投递：`POST /api/agent`，鉴权用 API key（存插件 secret）。注意该接口对 worker 强制跳过审批。
- worktree：写代码角色由 broker 执行 `git worktree add`，路径沿用 CloudCLI 约定 `<repo>-worktrees/coagent-<run_id>-<agent_id>`，分支 `coagent/<run_id>/<agent_id>`（id 为 `<role>-<6 hex>`，跨 run 不碰撞），作为 `projectPath` 传入（自动注册为项目）。只读角色共享 lead 目录。spawn 先建 worktree，再在一个事务里写 agent+spawned 事件+任务消息，失败则回滚并删除 worktree/分支；首轮与普通消息走同一投递路径。
- 投递状态机：`messages.delivery_state` = `queued → dispatching（attempts+1, lease_until）→ delivered`；`cancelled` 表示收件人已 ended/merged。只有 409 或 CloudCLI 接受 turn 之前的错误才回 `queued`；一旦接受（收到 session-id / turn_start），出错也关闭该投递、worker 置 `error` 并通知 lead，是否重试由 lead 决定。`report_result` 在同一事务里确认该 worker 当前的 dispatch。`delivered_at` 仍表示投递时间。进程内的 turn 每次 tick 续租；租约过期的孤儿投递：worker 的一律关闭（不重发），lead 的回队。
- 启动恢复（`Broker.recover()`，server 启动时 await，请求和 tick 都等它完成）：对仍标 `starting/running` 的 worker 调 CloudCLI `GET /api/agent/sessions/:id`（fork 新增，`capabilities.sessionStatus`）：`processing=false` → `interrupted`；`true` → 保持 `running` 但不归本进程所有（detached），每 30s 复查，结束且未汇报则置 `idle` 并通知 lead，期间其 `report_result` 照常生效、不推新 turn；未知（宿主无该接口或出错）→ `interrupted`，且 `end_agent remove_worktree` 被拒（该操作只在会话确认空闲时允许）。lead 收到 system 消息（`send_message` 续跑或 `end_agent`），任务从不自动重发；记 `recovered` 事件。
- **已知限制：lead 的 turn 可能部分重复。** lead 没有 interrupted 状态：broker 在 lead turn 中途崩溃时，该 turn 携带的消息在租约过期后回队并重发一次，若该 turn 已部分执行（例如已 spawn 或发消息），lead 会再看到同一批消息。没有 turns 表/provider run id，无法判断它执行到哪里。
- 容量：占名额的是正在工作的 worker（starting/running/busy/detached）、`interrupted` 的、有 queued/dispatching 消息的，以及有未合并 worktree 的写角色。给不占名额的 worker 发返工时若已满，消息保持 queued、告知发送方，有空位后才投递。`end_agent`（lead 工具，或 tab 抽屉「End agent」）在任何 await 之前用一个事务置 `ended` 并取消其 queued 消息（停止屏障），之后才清理；清理失败只报告，不会恢复投递。ended/merged 的 agent 除 `list_agents` 外的工具调用一律被拒。`remove_worktree: true` 才删 worktree。
- 消息：收件箱模型。agent 可主动 `read_inbox`；agent 一轮结束（空闲）时 broker 将未读消息作为下一轮输入自动投递；409（运行中）则排队重试。
- 关卡：
  - 计划：lead `submit_plan` → pending → tab 中批准/驳回+意见 → 结果经收件箱回到 lead。
  - 合并：worker `report_result` → lead `request_merge` → tab 审批 → **broker 执行合并**到 lead 分支；冲突回传 lead。
- 生命周期：worker 完成后会话保留为 idle，可通过 `send_message` 返工（同 sessionId）；合并成功后删 worktree、保留分支；「结束协作」清理未合并 worktree 前二次确认。

### 4.3 `plugin/` 前端 tab

- tab 与 Chat/Shell/Files/Git 并列，存在于每个会话；按 `api.context.session` 上下文渲染：
  - 当前会话属于某协作 → 该协作看板，高亮「我」
  - 否则 → 所有协作列表
- 面板：原定 agent 列表/任务看板/消息流/待审批；**已被 §9 的泳道时间线取代**，目前没有独立的 task 实体或看板（见 ROADMAP 方向 6）。
- 跳转：新浏览器标签打开 `/session/<id>`（稳定）；或 `history.pushState` + `popstate` 当前页跳转（hack）。
- v1 不在 tab 内嵌会话流式输出。

## 5. 已知取舍

- `/api/agent` 拉起的 worker 跳过审批（Claude `bypassPermissions`，Codex `approvalPolicy: never`），以 worktree 隔离 + 两道关卡兜底；Claude worker 仍可写 worktree 之外的路径。
- 用户级 MCP 全局可见，非协作会话也能看到工具。
- API key 仅对 `/api/agent` 生效，插件后端无法调用 CloudCLI 其他接口。
- AGPL：插件独立分发；fork 若分发或对外托管须开源。

- **broker 投递给 lead 的轮次同样跳过审批**：lead 自己发起、用户在 UI 里正常对话的轮次权限审批照常；但 broker 经 `/api/agent` 投递消息（计划批准、worker 结果等）触发的那一轮，lead 也以 `bypassPermissions` 运行。上游 PR 1 可以修复这一点。

## 5.1 实现中由事实推翻/修正的决定（2026-11-25）

- **不做 monorepo**：CloudCLI 安装插件时在仓库根执行 `npm install && npm run build`，要求根目录就是插件。改为单包：`src/{broker,shim,frontend,shared}`、`prompts/`、`patches/`；pnpm 改 npm。
- **运行时零依赖**：esbuild 把 broker、shim、tab 各自打包为单文件（tab 以 Blob URL 加载，必须自包含）。
- **SQLite 用 `node:sqlite`** 而不是 better-sqlite3：免原生编译；CloudCLI 用的 Node 22.23 自带。
- **状态目录** `~/.cloudcli-coagent/`（db + `runtime.json`），独立于插件目录，重装不丢。
- **CloudCLI 没有设置插件 secret 的 UI**：tab 首次使用时粘贴 API key → broker 先向 CloudCLI 验证（空 body 打 `/api/agent`，401=无效）→ 写入 `plugins.json` 的 `coagent.secrets.apiKey`。之后所有 tab 请求以代理注入的 `x-plugin-secret-apikey` 鉴权。
- **CloudCLI 不认软链插件目录**：开发安装用 `scripts/dev-install.sh`（rsync + 重启 broker）。
- **Claude 注册走 `claude mcp add -s user`**（运行中的 claude 会改写 `~/.claude.json`，不直接编辑）；Codex 直接写 `config.toml`（首次写前备份 `.coagent.bak`）。
- **身份绑定**：worker 首次调用时 provider id 可能尚未写进 CloudCLI DB，用「agent_id + 尚未绑定」做首次绑定（TOFU）；已绑定后，不同 session 冒用会被拒绝。

## 5.2 端到端实测（本机 CloudCLI v1.37.9，2026-11-25）

API 创建的 Claude lead → `submit_plan` 自动升级 → 批准 → 派 Claude coder（独立 worktree）→ `report_result` → lead `request_merge` → 批准 → broker `--no-ff` 合并、删除 worktree、保留分支 → 用户消息让 lead 派 **Codex reviewer**（在 CloudCLI 的 codex app-server 中经 `_meta` thread_id 识别）→ 审查结论回到 lead。全程未改 CloudCLI。
未覆盖：tab UI 渲染（浏览器工具缺 Chromium）、UI 中创建的会话作为 lead。

## 6. 上游 PR 路线（插件跑通、碰到天花板后再做）

1. `/api/agent` 支持 `permissionMode`，审批请求转发到 UI 对应会话
2. REST 版 steer（给运行中的会话插话）
3. 插件订阅会话事件（多 agent 同屏）
4. 按 run 注入 MCP / env（让非协作会话看不到 coagent 工具）

## 7. 仓库结构与测试（已过时：实际结构见 §5.1 与 README）

```
cloudcli-coagent/          pnpm monorepo, TypeScript
├── plugin/                基于 cloudcli-plugin-starter：tab 前端 + broker 后端（better-sqlite3）
├── mcp-shim/              stdio MCP（@modelcontextprotocol/sdk）
├── prompts/               lead / worker / 角色 / 流水线模板
├── patches/               暂空
└── docs/
```

- vitest：broker 单元 + 集成（mock `/api/agent`）。
- 端到端冒烟：对本机 CloudCLI（:3001）跑「lead 派一个 worker」。
- 安装：开发期软链到 `~/.claude-code-ui/plugins/`；发布推 git 仓库后在 CloudCLI 中按 URL 安装。

## 8. 下一步：spike（一次性，验证地基假设）

| # | 假设 | 不成立时影响 |
|---|------|------------|
| 1 | Codex 拉起的 MCP 子进程能拿到 `CODEX_THREAD_ID` | Codex 身份退回自报 |
| 2 | 插件 tab 在每个会话都存在，切换触发 `onContextChange` | §4.3 上下文渲染 |
| 3 | `/api/agent` 能用 provider session id 续写 UI 创建的会话；会话忙时返回 409 | §3 自动升级、§4.2 消息投递 |
| 4 | 用户级 MCP 会被 CloudCLI 拉起的 Claude / Codex 会话加载 | §4.1 注入方式 → 需提前 fork PR 4 |

任一不成立 → 回到设计树重新讨论受影响分支。

### Spike 结果（2026-11-25）

| # | 结论 | 证据 |
|---|------|------|
| 1 | ❌ 原假设不成立，✅ 替代方案成立：MCP 子进程无 `CODEX_*` env；但 `tools/call._meta["x-codex-turn-metadata"].thread_id` 可用 | codex-cli 0.156.1 `codex exec` + 记录请求的探针 MCP |
| 2 | ✅ tab 是工作区级组件，宿主在 project/session 变化时调用 `onContextChange`，插件不重新挂载；`context.session.id` 为 app id | 上游 `src/modules/plugins/PluginTabContent.tsx`、`project-workspace/WorkspaceMain.tsx:223` |
| 3 | ✅ 运行时实测：新建会话响应同时返回 `sessionId`（app）与 `providerSessionId`；用 provider id 续写成功且保留上下文；会话运行中再投递返回 `409 {"error":"Session … already has a run in progress"}`。注意：**续写时仍必须带 `projectPath`**，否则 400。实测对象为 API 创建的会话；UI 创建的会话走同一 DB 查找路径（源码确认） | 对本机 :3001 的 `POST /api/agent` |
| 4 | ✅（源码级）Claude：`settingSources` 含 `user` 且 `loadMcpConfig` 合并 `~/.claude.json` 的 `mcpServers`；Codex：正常会话加载 `~/.codex/config.toml`（只有 side question 显式禁用） | `claude-runtime.provider.ts:447,1116,1330`；`codex-app-server.client.ts:349` |

另：Claude MCP 进程继承 `CLAUDE_CODE_SESSION_ID` 已在本机运行进程中确认。

## 9. 时间线视图（2026-11-25）

tab 改为泳道时序图：每个 agent 一条泳道（最左为 You），时间自上而下、最新在底部。消息是泳道间箭头，broker 投递的轮次是色条，派生/审批/合并是节点；待审批吸顶，点击任意元素在底部抽屉看详情和操作。数据来自 messages + 新增 `events` 表（`run_started/spawned/turn_start/turn_end/gate_opened/gate_decided/merge/run_ended`）。用户在 UI 里直接与 lead 的对话不经过 broker，不显示为色条。

## 10. Fork：worktree 项目归组（patch 1）

- 事实：CloudCLI 的会话同步器按会话 cwd 反复覆盖 `sessions.project_path`（`sessions.db.ts`），所以无法让 worktree 会话归属 lead 项目；归档项目又会隐藏会话。
- 做法：项目带 `worktreeOf`（主仓库路径：活 worktree 读 `.git` 文件；已删除的按 `<repo>-worktrees/<name>` 布局，且仅当 `<repo>` 是已知项目），侧边栏把 worktree 项目缩进显示在主仓库下（主仓库展开时可见，选中时总可见）。不移动任何会话。参照 Zed：“Threads running in linked Git worktrees appear under the same project as their main worktree.”
- 位置：fork 仓库 https://github.com/hectorqin/claudecodeui 分支 `coagent/v1.37.10-coagent.2`（基于 v1.37.10，含 patch 1–3），补丁 `patches/000{1,2,3}-*.patch`。

## 11. 同类工具调研要点（2026-11-25）

| 工具 | 展示 | 协作 |
|---|---|---|
| T3 Code | 收件箱式侧边栏（Pin/Snooze/Settle，Approval 徽标，Working+耗时）；子 agent 卡片在父线程时间线中，详情里有 Lineage | `delegate_task` 派子任务（可跨 provider、可独立 worktree）；所有子任务完成后父线程自动唤醒并拿到结果；子任务审批卡片出现在父对话中 |
| CodexHost | 宿主 Codex Desktop：每个会话在侧边栏，子 agent 在右侧打开，每轮有变更摘要+Diff | `#agent` 提及即委派；委派任务是独立原生会话，结束时通知发起会话；审批留在各自 harness |
| Codex App | 按项目组织线程，内置 worktree，只读 Subagents 视图（Active/Done） | 子 agent 回传摘要；等所有结果到齐再汇总；子 agent 继承父的沙箱与审批设置 |
| Zed | 线程侧边栏按项目分组，worktree 线程归到主项目下 | 线程相互独立，合并走常规 git |
| Cline Kanban | 每张卡是一个活的 agent 任务 | 依赖关系：父任务完成自动触发后续任务 |

共性：子 agent = 独立会话、结果回父；worktree 隔离；审批跟随发起线程并在父/侧边栏可见；代码合并几乎都交给 git/PR。

## 12. 主会话内展示与协作节奏（2026-11-25，Q34–Q37）

- **内联审批（Q34）**：Claude lead 的 `submit_plan`/`request_merge` 通过 MCP elicitation 在 lead 对话里弹“批准/驳回+意见”表单（CloudCLI 已桥接，`claude-runtime.provider.ts`），工具调用阻塞到有决定；tab 里也能批，先到先得，tab 决定后表单被撤回（实测 `permission_cancelled`）。Codex lead 或表单被拒/无人值守 → 退回异步关卡。
- **`wait_for_agents`（Q35）**：shim 每 2.5s 轮询 broker，调用保持打开（像原生子 agent）。`mode: all`（默认，全部完成一次返回）/ `any`（首个结果即返回）。失败、worker 提问、用户消息、关卡决定一律提前返回。单次最长 30 分钟。lead 未在等待时，结果凑齐再投递，紧急消息立即投递。
- **超时**：Claude 注册改用 `claude mcp add-json` 并设 `timeout: 7200000`（stdio 默认空闲超时 30 分钟、取与 timeout 的较大值）；Codex `tool_timeout_sec = 7200`（默认 60s）。实测 Claude 非交互模式下 150 秒阻塞调用正常返回。
- **`unattended:false`（Q37）**：broker 经 `/api/agent` 发起的轮次也能弹表单。
- **子 agent 卡片（Q36，fork patch 2）**：CloudCLI 新扩展点——manifest `toolRenderers` + 模块导出 `renderTool(container, ctx, host)`；coagent 用它把 `mcp__coagent__*` 渲染成卡片：spawn/wait 显示每个 worker 的状态、最近 3 条活动（broker 从 `/api/agent` 事件流截取）、结果和“Open ↗”；计划/合并显示关卡状态。
- **实测**（真实 CloudCLI + Claude）：计划审批 → 派 coder → wait_for_agents → 合并审批 → 总结，全程在 lead 的**一轮**内完成，broker 未额外唤醒 lead。
- 未实测：卡片在真实 UI 中的渲染（需安装 fork 后查看）；Codex lead 的完整流程。

## 13. Token/耗时可见性（2026-11-25，ROADMAP 方向 5）

- **数据源（已核对 CloudCLI v1.37.10 源码，引用见 `src/broker/usage.ts`）**：`/api/agent` SSE 中的 `{kind:'status', text:'token_budget', tokenBudget}`。
  - Claude：每条主线程 assistant 消息一次，是**该次请求的上下文快照**（`used`=整段 prompt+输出，`total`=上下文窗口），不是本轮用量，也不累计；跨 turn 相加会重复计算。
  - Codex：每轮 `turn.completed` 一次，是**本轮用量**（input/output，可跨 turn 相加）；`total` 恒为默认 200000、`used` 是本轮 input+output，均不代表上下文占用，记为未知。
- **`turns` 表**：CloudCLI 接受 turn（收到 session-id）时写入一行，结束时写 `ended_at/duration_ms/outcome(ok|error)`；用量列保存该 turn 最后一个 usage 事件，`usage_kind` 区分 `context`（快照）与 `turn`（账单）。409/接受前出错不写行。重启时 `recover()` 把遗留的未结束行置 `interrupted`（时长未知，保留已见用量）。
- **汇总**：`AgentDTO.usage`（turns、总时长含进行中 turn、当前 turn 时长、最新上下文快照、仅对 `turn` 类求和的 input/output）；`RunDTO.usage` 为 run 合计（不含上下文）。未知一律为 null，UI 显示 “—”，不显示美元。
- 只覆盖 broker 跑的 turn；用户在 UI 里直接与 lead 的对话不经过 broker，不计入。
