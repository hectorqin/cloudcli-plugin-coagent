# CoAgent for CloudCLI

Multi-agent collaboration as a [CloudCLI](https://github.com/siteboon/claudecodeui) plugin: any Claude or Codex session
can become a **lead** that plans, spawns worker sessions (each writer in its own git worktree), exchanges messages with
them, and merges their branches. The user approves the plan and every merge in the CoAgent tab. No CloudCLI patches.

```
 lead session ──MCP──▶ coagent shim ──HTTP──▶ broker (plugin server, SQLite)
     ▲                                          │  POST /api/agent (API key)
     └──────── inbox delivery / new sessions ◀──┘──▶ worker sessions (claude | codex)
```

## How it works

- **MCP shim** (`dist/mcp-shim.js`) is registered user-wide for Claude (`claude mcp add -s user`) and Codex
  (`~/.codex/config.toml`). It identifies the calling session without trusting the model: `CLAUDE_CODE_SESSION_ID`
  for Claude, the `x-codex-turn-metadata.thread_id` request metadata for Codex.
- **Broker** (`dist/server.js`) is the plugin server. It holds runs, agents, messages and gates in
  `~/.cloudcli-coagent/coagent.db`, starts and continues sessions through CloudCLI's Agent API, and delivers queued
  messages when a recipient is idle (retrying on 409).
- **Tab** (`dist/index.js`) shows the run the current session belongs to (or all runs): agents, messages, and
  pending plan/merge approvals.

Tools: `submit_plan`, `spawn_agent`, `wait_for_agents`, `send_message`, `read_inbox`, `report_result`, `request_merge`,
`list_agents`. With a Claude lead, plan and merge approvals appear as a form in the lead's chat (MCP elicitation), and
`wait_for_agents` keeps the call open until the workers are done, so delegation reads like native subagents. With the
CloudCLI fork's `toolRenderers` extension point, these calls render as live worker cards.
Protocol prompts live in `prompts/` and are read fresh on every use.

## Install

In CloudCLI: Settings → Plugins → install from this repository's git URL. Then open the CoAgent tab, paste a CloudCLI
API key (Settings → API Keys), and save.

Development: `npm install && npm test && ./scripts/dev-install.sh` (CloudCLI ignores symlinked plugin folders, so the
script syncs the build into `~/.claude-code-ui/plugins/cloudcli-coagent` and restarts the broker).

## Use

In any CloudCLI Claude/Codex session: *"Plan this and delegate it to sub-agents."* The session calls `submit_plan` and
becomes the lead. Approve the plan in the tab; workers appear there; approve merges when the lead requests them.

## Caveats

- Sessions started through CloudCLI's Agent API run with permissions bypassed. That covers every worker turn and
  every lead turn the broker delivers. Writers are confined only by convention to their worktree.
- The MCP server is registered user-wide, so every Claude/Codex session sees the coagent tools (they do nothing
  until a session submits a plan).

See `docs/DESIGN.md` for the full design and the verified assumptions behind it.

## License

MIT for the plugin. The files in `patches/` modify CloudCLI and are AGPL-3.0 like CloudCLI itself; see `LICENSE`.
The patched CloudCLI build lives in the fork: https://github.com/hectorqin/claudecodeui (branch `coagent/v1.37.10-coagent.2`).
