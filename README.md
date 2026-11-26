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

## Install / Upgrade / Uninstall

CloudCLI requires Node.js 22.13 or newer for CoAgent's `node:sqlite` database.

To install, open CloudCLI **Settings → Plugins**, choose the git URL option, and enter this repository's URL. CloudCLI
clones the repository into `~/.claude-code-ui/plugins/`, runs `npm install`, and then runs `npm run build`. Open the new
CoAgent tab, create an API key under **Settings → API Keys**, paste it into the tab, and save it. The broker registers
the MCP shim and CoAgent skill automatically; the tab also has explicit **Register MCP + skill** and
**Unregister MCP + skill** actions. **Unregister MCP + skill** also turns automatic registration off, so a restart does
not re-register; **Register MCP + skill** turns it
back on. The tab header shows the current setting.

To upgrade, use the plugin update action in **Settings → Plugins**. CloudCLI fast-forwards its shallow clone of the
repository's default branch; its URL installer does not select tags. CoAgent backs up an older database immediately
before schema migration and keeps the five newest snapshots under `~/.cloudcli-coagent/backups/`. Its state directory
is outside the cloned plugin, so reinstalling does not erase runs.

The backup runs before the broker reports ready, and CloudCLI stops a plugin that is not ready within 10 seconds. Each
backup's duration and size are logged. If the database is larger than 512 MiB the broker refuses to start rather than
risk being killed mid-copy, and the error says what to do: copy `~/.cloudcli-coagent/coagent.db` somewhere safe, then
`touch ~/.cloudcli-coagent/skip-next-backup` and restart the plugin. That marker skips the backup once and is deleted
when used. (`COAGENT_SKIP_BACKUP=1` does the same when you start `dist/server.js` yourself; CloudCLI does not pass
custom environment variables to plugins.)

CoAgent writes the following user-level state:

- `~/.claude.json`: `mcpServers.coagent`, managed through `claude mcp add-json -s user` / `claude mcp remove -s user`.
- `~/.codex/config.toml`: `[mcp_servers.coagent]` (the original file is backed up once as `config.toml.coagent.bak`).
- `~/.claude/skills/coagent/SKILL.md`: the Claude `/coagent` skill.
- `~/.agents/skills/coagent/SKILL.md`: the Codex `$coagent` skill (CloudCLI and Codex also discover this global source).
- `~/.cloudcli-coagent/`: the database, migration backups, runtime discovery file, and broker log.

Skill directories include a `.coagent-owned` marker. `SKILL.md` is managed content, so edits to it are overwritten on
registration. Delete `.coagent-owned` to take ownership: future registration and unregistration then report
`skipped: user-managed skill` and leave the directory untouched. Existing unmarked user-authored skills are likewise
left untouched. Unregistration removes only the managed `SKILL.md` and marker, preserving other files in the directory.

To uninstall safely, first click **Unregister MCP + skill** in the CoAgent tab. Then remove the plugin in **Settings → Plugins**.
If the tab is no longer available, run `claude mcp remove -s user coagent` and remove only the
`[mcp_servers.coagent]` section from `~/.codex/config.toml`. You may also remove
`~/.claude/skills/coagent/` and `~/.agents/skills/coagent/` if their `.coagent-owned` marker is present. Never remove
an unmarked directory, because it belongs to the user. You can also delete the one-time
`~/.codex/config.toml.coagent.bak` after confirming the remaining config is correct. Finally, after preserving anything
you need, delete `~/.cloudcli-coagent/` to remove all run data and backups. Restart existing Claude and Codex sessions
so their tool lists are refreshed.

For development, run `npm install && npm test && ./scripts/dev-install.sh`. CloudCLI ignores symlinked plugin folders,
so the script copies the build into `~/.claude-code-ui/plugins/cloudcli-coagent` and restarts the broker.

## Compatibility

Vanilla CloudCLI 1.37.9 and newer provides the CoAgent core workflow and tab. The optional CloudCLI fork at
https://github.com/hectorqin/claudecodeui, branch `coagent/v1.37.10-coagent.2`, additionally provides live chat tool
cards through `toolRenderers`, sidebar grouping for worker worktrees, and session-status-aware recovery. Those enhanced
views are not required for the core tab workflow; unsupported hosts fall back to their normal tool-call display.

## Use

In any CloudCLI session, invoke `/coagent <task>` in Claude or `$coagent <task>` in Codex. The session calls
`submit_plan` and becomes the lead. You can also ask it to “plan this and delegate it to sub-agents.” Approve the plan
in the tab; workers appear there; approve merges when the lead requests them.

The globally discovered skill may also appear in plain Claude Code or other hosts, but CoAgent runs require its MCP
tools and therefore work only in CloudCLI Claude/Codex sessions. If `submit_plan` is unavailable, the skill stops and
explains this requirement.

## Cleaning up

Merging a writer removes its git worktree but deliberately keeps its CloudCLI project, sessions, transcripts, and
branch. After the merge, its approval card and the CoAgent agent/gate drawers offer **Archive worker session** and
**Delete** when the host supports project cleanup. Archive hides the project while preserving sessions so it can be
restored from the sidebar archive view; Delete requires confirmation and permanently removes the project, sessions,
and transcripts. Read-only planner/reviewer sessions share the lead project and are never offered either action.

After ending a run, the tab offers **Archive all worker sessions** and **Delete merged branches**. Branch cleanup is
explicit and conservative: it considers only workers recorded as merged, requires their tips to be ancestors of the
lead's current `HEAD`, and uses `git branch -d`. Unmerged, ended-unmerged, missing, or still-checked-out branches are
reported as skipped and are left intact. On vanilla CloudCLI, project cleanup functions are unavailable and the UI
points to the worker project under the repository's sidebar worktree group instead.

The tab only shows branch cleanup to the lead session, but this is a UI guard rather than a security boundary: every
tab request is already authorized as the CloudCLI user. Git's ancestry check and `branch -d` are the deletion safety
boundary.

## Caveats

- Sessions started through CloudCLI's Agent API run with permissions bypassed. That covers every worker turn and
  every lead turn the broker delivers. Writers are confined only by convention to their worktree.
- The MCP server is registered user-wide, so every Claude/Codex session sees the coagent tools (they do nothing
  until a session submits a plan).

See `docs/DESIGN.md` for the full design and the verified assumptions behind it.

## License

MIT for the plugin. The files in `patches/` modify CloudCLI and are AGPL-3.0 like CloudCLI itself; see `LICENSE`.
The patched CloudCLI build lives in the fork: https://github.com/hectorqin/claudecodeui (branch `coagent/v1.37.10-coagent.2`).
