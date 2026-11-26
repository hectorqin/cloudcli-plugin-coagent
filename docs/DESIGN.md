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
- 工具：`spawn_agent`、`send_message`、`read_inbox`、`report_result`、`submit_plan`、`request_merge`、`wait_for_agents`、`end_agent`、`handoff_agent`（§15）、`list_agents`。
- 非协作会话调用时返回「未加入协作」（`spawn_agent` 除外，它触发升级）。

### 4.1.1 显式启动 skill

插件随包发布同一份 `skills/coagent/SKILL.md`，注册时分别安装到
`~/.claude/skills/coagent/SKILL.md`（Claude：`/coagent`）和
`~/.agents/skills/coagent/SKILL.md`（Codex：`$coagent`）。CloudCLI 的 Codex provider 也把后者作为全局默认
skill source。skill 只负责发起 `submit_plan` 并强调跨 provider review 和中断续跑；完整协议仍由工具结果提供。
Claude 专用的 `disable-model-invocation: true` 使其只能由用户显式调用；CloudCLI/Codex 的解析器只读取
`name` 与 `description`，会忽略这个未知字段。自然语言委派仍可由 `submit_plan` 自己的 tool description 触发。
全局发现可能让 plain Claude Code 或其他宿主也显示该 skill，但缺少 `submit_plan` 时必须说明 CoAgent 仅支持
CloudCLI Claude/Codex 会话并停止。每个安装目录带 `.coagent-owned` 标记；`SKILL.md` 是会被升级覆盖的托管文件。
用户删除 marker 即接管整个目录，此后注册和卸载均跳过；卸载托管 skill 时只删除 `SKILL.md` 与 marker，
保留目录中的其他文件。MCP 与 skill 共用 `autoRegister` 开关和 tab 注册/卸载操作。

### 4.2 `plugin/` 后端 = broker

- 状态：插件自有 SQLite（`~/.cloudcli-coagent/coagent.db`）为唯一事实源。原定的 `.coagent/` markdown 导出**未实现**。
- 派活 / 投递：`POST /api/agent`，鉴权用 API key（存插件 secret）。注意该接口对 worker 强制跳过审批。
- worktree：写代码角色由 broker 执行 `git worktree add`，路径沿用 CloudCLI 约定 `<repo>-worktrees/coagent-<run_id>-<agent_id>`，分支 `coagent/<run_id>/<agent_id>`（id 为 `<role>-<6 hex>`，跨 run 不碰撞），作为 `projectPath` 传入（自动注册为项目）。只读角色共享 lead 目录。spawn 先建 worktree，再在一个事务里写 agent+spawned 事件+任务消息，失败则回滚并删除 worktree/分支；首轮与普通消息走同一投递路径。
- 投递状态机：`messages.delivery_state` = `queued → dispatching（attempts+1, lease_until）→ delivered`；`cancelled` 表示收件人已 ended/merged。只有 409 或 CloudCLI 接受 turn 之前的错误才回 `queued`；一旦接受（收到 session-id / turn_start），出错也关闭该投递、worker 置 `error` 并通知 lead，是否重试由 lead 决定。`report_result` 在同一事务里确认该 worker 当前的 dispatch。`delivered_at` 仍表示投递时间。进程内的 turn 每次 tick 续租；租约过期的孤儿投递：worker 的一律关闭（不重发），lead 的回队。
- 启动恢复（`Broker.recover()`，server 启动时 await，请求和 tick 都等它完成）：对仍标 `starting/running` 的 worker 调 CloudCLI `GET /api/agent/sessions/:id`（fork 新增，`capabilities.sessionStatus`）：`processing=false` → `interrupted`；`true` → 保持 `running` 但不归本进程所有（detached），每 30s 复查，结束且未汇报则置 `idle` 并通知 lead，期间其 `report_result` 照常生效、不推新 turn；未知（宿主无该接口或出错）→ `interrupted`，且 `end_agent remove_worktree` 被拒（该操作只在会话确认空闲时允许）。lead 收到 system 消息（`send_message` 续跑或 `end_agent`），任务从不自动重发；记 `recovered` 事件。
- **已知限制：lead 的 turn 可能部分重复。** lead 没有 interrupted 状态：broker 在 lead turn 中途崩溃时，该 turn 携带的消息在租约过期后回队并重发一次，若该 turn 已部分执行（例如已 spawn 或发消息），lead 会再看到同一批消息。没有 turns 表/provider run id，无法判断它执行到哪里。
- 容量：占名额的是正在工作的 worker（starting/running/busy/detached）、`interrupted` 与 `paused`（§15）的、有 queued/dispatching 消息的，以及有未合并 worktree 的写角色。给不占名额的 worker 发返工时若已满，消息保持 queued、告知发送方，有空位后才投递。`end_agent`（lead 工具，或 tab 抽屉「End agent」）在任何 await 之前用一个事务置 `ended` 并取消其 queued 消息（停止屏障），之后才清理；清理失败只报告，不会恢复投递。ended/merged 的 agent 除 `list_agents` 外的工具调用一律被拒。`remove_worktree: true` 才删 worktree。
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
- 位置：fork 仓库 https://github.com/hectorqin/claudecodeui 分支 `coagent/v1.37.10-coagent.3`（基于 v1.37.10，含 patch 1–4），补丁 `patches/000{1,2,3,4}-*.patch`。

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
- **已知限制（上下文可能偏高）**：SDK 不带逐条 assistant usage 时，CloudCLI 退回 `extractCumulativeTokenBudget`（整轮账单，含所有请求与子 agent），线上无法区分，此时 “ctx” 可能是实际占用的数倍。coagent 无法可靠修正，UI 在提示中标注为近似值。
- **用户中止**：已被接受的 turn 被用户在 CloudCLI 中止时（`complete.aborted` / `status.aborted`），send 返回 `aborted`，turn 记 `aborted`，投递关闭不重试，worker 置 idle 并以 system 消息告知 lead（不按失败处理）。
- **查询开销**：`/state` 的 run 列表与当前 run 的 agent 用量都用分组查询批量计算，查询数不随历史增长。迁移项以 `MIGRATIONS`（含 `TURNS_MIGRATION`）导出，`pendingMigrations(db)` 只读判断是否需要迁移。
- 只覆盖 broker 跑的 turn；用户在 UI 里直接与 lead 的对话不经过 broker，不计入。

## 14. 合并后的清理（2026-11-26，Q38–Q40）

- writer 合并后自动删除 git worktree，但保留 CloudCLI project/session/transcript 和分支。planner/reviewer 与 lead 共用 project，绝不能归档或删除该 project；完成后只对它自己的 app session 调 session 级清理，且拒绝缺失或等于 lead session 的 id。
- fork 在 tab API 与 tool renderer host 暴露可选的 `archiveProject` / `deleteProject` 和 `archiveSession` / `deleteSession`。合并卡片与 agent/gate 抽屉按 worker 类型和 host 能力显示“Archive worker session”和需确认的 Delete；vanilla host 显示 sidebar 提示。run 结束后的批量归档对 writer 用 project API、对只读 worker 用 session API，逐项且互不阻塞。
- UI 成功调用 host 后，通过 tab 鉴权的事件路由记录 `workspace_archived` / `workspace_deleted`；失败只显示对应 item 的错误，不阻断其他清理。
- 分支清理与 `endRun` 分离且从不自动执行。lead 显式调用 `POST /runs/:id/branches/delete-merged`：仅处理状态为 merged 且 tip 是 lead 当前 `HEAD` ancestor 的 worker 分支，并只用 `git branch -d`。未合并、ended-unmerged、缺失或仍被 worktree checkout 的分支均保留并返回原因；结果记录为 `branches_deleted`。这里的“仅 lead”是 tab UI/一致性 guard，不是独立授权边界（tab 请求已经代表本机 CloudCLI 用户）；真正的删除安全边界是 ancestry 检查与 `branch -d`。

## 15. 额度暂停、自动续跑与 handoff（2026-11-26，Q41–Q42）

- **识别（`src/broker/quota.ts`）**：只看 run 的**终止失败**。`HttpCloudCli.send`（`readRun`）按 CloudCLI 契约读流：每个 run 恰好一个 `complete {exitCode, success, aborted}`；成功的 `complete` → ok（之前的 error 事件不再让 turn 失败）；失败的 `complete` → error，若紧挨着它之前（中间只隔 status/生命周期事件）有 `kind:'error'`，那就是失败原因，标 `terminal: true`；路由自身的 `{type:'error'}` 和 `/api/agent` 的 HTTP 状态也是 terminal；没有 `complete` 的旧宿主，只有最后一个事件是 error 时才算 terminal。中途的 error 事件（例如 agent 调试某个外部 API 的 HTTP 429）不是 terminal。
  - 供应商专有措辞无条件识别：`hit your … limit`（含 “You've hit your usage limit”）、`N-hour limit`、`insufficient_quota`。
  - 通用措辞只在 terminal 时识别：`usage limit`、`quota exceeded`、`rate limit`/`rate_limit_error`、`too many requests`、独立的 `429`。
  - 重置时间：`try again at 7:13 PM`、`resets 7:10pm (UTC)`、`GMT+2`、IANA 时区、`in 20 minutes` 等，取 `now` 之后最近一次并加 1 分钟余量。IANA 时区按**目标日期**的偏移迭代求解（`Intl`），跨 DST 切换（如 Europe/Paris 2026-03-29、2026-10-25）也正确；翻到次日时重新求解。**未带时区一律按 UTC**（代码注释说明：broker 无从得知 provider 用的时区；猜早了只会再暂停一次）。
  - 上限：解析结果必须是有限值、在未来、且不超过 7 天（`MAX_PAUSE_MS`），否则视为读不出，改用 `quotaBackoffMinutes`（kv，`PUT /config` 可改，默认 30，同样夹在 7 天内；`pause()` 再校验一次）。
  - lead 的 turn 不受影响（lead 无暂停）。
- **状态 `paused`**：`agents` 新列 `resume_at`、`pause_reason`、`pause_nudge`（幂等迁移，`MIGRATIONS` 最后一项）。不置 `error`；记 `paused {reason, resumeAt, guessed, error}`；给 lead system 消息 “`<id>` paused (usage limit), auto-resume at `<time>`”。`pause_nudge` = 被打断的 turn 是否已被 CloudCLI 接受：接受过则续跑时要告诉它“上一轮被打断”；未接受（如 HTTP 429）消息已回队，续跑时直接投递即可。
- **自动续跑**：`tick()` 对到点的 paused worker（`pausedDue`，只看 active 且未 ending 的 run）在同一事务里置 `idle`、清除暂停信息、按需入队一条 system 消息 “[coagent] Your previous turn was interrupted (<reason>). Check your worktree state (git status / git diff) and continue the task; report_result when done.”，记 `resumed {by:'auto'}`，然后按普通投递发给**同一 session**（同 appSessionId）。该消息就是一次普通投递，不会重发；若这一轮又撞额度，按上面规则重新 `paused`（新的 resumeAt）。
  - `paused` 在 `NO_DELIVERY` 中：期间发给它的消息保持 queued，续跑时随之投递；`send_message` 会告知发送方。
  - 占名额（`holdsSlot`），但不算“即将出结果”的 active worker，因此不会拖住其他 worker 结果的批量投递。
  - `end_agent` 置 `ended` 同时清掉 `resume_at`（`agent_ended.cancelledResume`）；`endRun`/ending 的 run 不续跑；`recover()` 只处理 starting/running，paused 原样保留，重启后照样到点续跑。
  - `request_merge` 拒绝 paused worker。
- **`wait_for_agents`**：暂停的 system 消息是紧急消息，所以等待会提前返回一次；返回文本列出 “`<id>` paused until `<time>`”，并提示“通常直接再 wait”。paused 不算 finished，所以再次 wait 会一直等到它续跑并完成。lead prompt 与 skill 同步说明。
- **不自动重试的仍不重试**：`error`/`interrupted` 的 worker 不自动续跑（沿用“已接受的 turn 出错不重试”）。tab 抽屉与 wait/spawn 卡片提供 **Resume**（`POST /agents/:id/resume`，tab 鉴权，发送同一条续跑消息，`resumed {by:'user'}`）；paused 的提供 **Resume now**（同一路由，跳过等待）和 **Cancel auto-resume**（`POST /agents/:id/cancel-resume`：改为 `interrupted`、记 `resume_cancelled`、通知 lead 决定）。
- **`handoff_agent(worker, provider, note?)`**（仅 lead）：把手工流程（end 旧 worker → spawn 新 worker → 合并旧分支 → `git diff | git apply --3way` 搬未提交改动）自动化。
  - 拒绝：worker 正在跑 turn（本进程 busy/dispatch/detached 或状态 running）；或 CloudCLI `sessionStatus` 不是明确的 `false`。与删除 worktree 相同的策略：`null`（未知：宿主无该接口或查询失败）也拒绝，并告诉 lead 安装 CloudCLI fork 或等 CloudCLI 能回答后重试（或自行 send_message / end_agent + spawn_agent）。快照、新 worktree 恢复完成后、结束旧 worker 之前**再查一次**（受 session-status 超时约束），若此时在处理或未知，则删除新 worktree/分支并中止，什么都不变。拒绝已 ended/merged 的 worker。
  - 子模块：子模块里的改动属于子模块自己的仓库，快照只能记录 gitlink。`snapshotWorkingTree` 先用 `git status --porcelain=v2` 的子模块标志（`S` + C/M/U：新提交、已修改、未跟踪）找出脏子模块，有则拒绝 handoff 并列出路径和问题。
  - 写角色：在 lead 仓库锁内，先对旧 worktree 做**内容快照**：复制其 index 到临时文件，用 `GIT_INDEX_FILE` 执行 `git add -A` + `write-tree`，得到包含已跟踪改动（含暂存）、删除、未跟踪且未被忽略文件的 tree，旧 worktree、它的 index 和 stash 都不动。然后 `createWorktree(..., startPoint = 旧 HEAD)`（git 层新增起点参数），在新 worktree 里 `read-tree -m -u HEAD <tree>` + `reset -q`：内容一致，全部变成未提交改动（原来暂存的新文件变为未跟踪，不丢数据）。最后对新 worktree 再做一次快照，**tree hash 必须相同**，否则删除新 worktree/分支并报错，什么都不变。被 `.gitignore` 忽略的文件不搬。
  - 只读角色：直接在 lead 目录用新 provider 起一个同角色 worker。
  - 一个事务内：旧 worker 的 pending 合并关卡置 rejected、旧 worker 置 `ended`（保留 worktree 与分支，释放名额，取消其 queued 消息，`agent_ended {handoff: <new>}`）、容量复核、创建新 worker（`spawned {handoffFrom}`）、记 `handoff {from, to, provider, carried}`、入队交接任务。交接任务包含：原始任务、旧 worker 最近约 12 条活动、最后的 result/错误、它未收到的消息、lead 的 `note`，并明确说明“已有工作就在你的 worktree 里”及搬过来的文件清单。复制期间旧 worker 被加入进程内 `handingOff` 集合，`deliver()` 不会给它开新 turn。
  - 时间线：`handoff` 画成旧泳道 → 新泳道的箭头；新泳道的 spawned 节点显示 “took over from …”。
- 未实测：真实 CloudCLI 下 Codex/Claude 额度错误经 `/api/agent` SSE 到达的确切形态（按用户提供的两条原文测试）；tab/卡片按钮在真实 UI 中的渲染。
