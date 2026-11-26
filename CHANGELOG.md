# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Workers that hit a provider usage or rate limit are `paused` (not failed) until the announced reset time (UTC when no
  timezone is given; configurable `quotaBackoffMinutes` otherwise), then resumed automatically in the same session.
  The pause survives restarts, keeps the worker's slot, and is cancelled by `end_agent`. `wait_for_agents` returns
  early once on a pause.
- Tab drawer and chat-card **Resume** for failed/interrupted workers, plus **Resume now** / **Cancel auto-resume** for
  paused ones (`POST /agents/:id/resume`, `POST /agents/:id/cancel-resume`).
- `handoff_agent(worker, provider, note?)`: moves a stopped worker's job to a new worker on another provider. A writer's
  new worktree starts at the old branch with its uncommitted and untracked changes carried over and verified. The
  timeline shows the handoff as an arrow between lanes.
- A shared `/coagent` (Claude) / `$coagent` (Codex) skill, safely installed and removed alongside MCP registration.
- Crash recovery with leased message delivery and session-status-aware detached worker recovery.
- Merge review snapshots with immutable worker/lead commits, file statistics, and bounded unified diffs.
- Hardened loopback HTTP handling, setup nonces, data-file permissions, structured redacted logs, and diagnostics.
- Release CI, production-install smoke testing, version/manifest validation, migration backups, and uninstall controls.

### Changed

- Run-scoped worktree/branch identities and safer worker capacity/termination behavior improve reliability.
- Registration and configuration failures are visible through the tab and diagnostics.

## [0.2.0]

### Added

- Swimlane timeline for agents, messages, events, and gates.
- Inline plan and merge approvals, including MCP elicitation for supported Claude sessions.
- Long-polling `wait_for_agents` orchestration.
- Live CoAgent chat tool cards through CloudCLI's optional `toolRenderers` extension.

## [0.1.0]

### Added

- Initial CloudCLI plugin with a SQLite broker, MCP shim, Claude/Codex workers, git worktrees, and plan/merge gates.

