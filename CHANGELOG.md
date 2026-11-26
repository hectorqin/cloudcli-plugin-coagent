# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.0] - 2026-11-26

### Added

- Workers that hit a provider usage or rate limit are `paused` (not failed) until the announced reset time (UTC when no
  timezone is given; configurable `quotaBackoffMinutes` otherwise), then resumed automatically in the same session.
  The pause survives restarts, keeps the worker's slot, and is cancelled by `end_agent`. `wait_for_agents` returns
  early once on a pause.
- Tab drawer and chat-card **Resume** for failed/interrupted workers, plus **Resume now** / **Cancel auto-resume** for
  paused ones (`POST /agents/:id/resume`, `POST /agents/:id/cancel-resume`).
- `handoff_agent(worker, provider, note?)`: moves a stopped worker's job to a new worker on another provider. A writer's
  new worktree starts at the old branch with its uncommitted and untracked changes carried over and verified. The
  timeline shows the handoff as an arrow between lanes. It is refused unless CloudCLI confirms the worker's session
  is idle (checked again before the switch), and when a submodule holds work that cannot be carried over.
- Turn outcomes follow CloudCLI's terminal `complete` event: an intermediate error event no longer fails a turn that
  completed, and only the run's terminal failure can be classified as a quota/rate limit by generic wording.
- A shared `/coagent` (Claude) / `$coagent` (Codex) skill, safely installed and removed alongside MCP registration.
- Crash recovery with leased message delivery and session-status-aware detached worker recovery.
- Merge review snapshots with immutable worker/lead commits, file statistics, and bounded unified diffs.
- Hardened loopback HTTP handling, setup nonces, data-file permissions, structured redacted logs, and diagnostics.
- Release CI, production-install smoke testing, version/manifest validation, migration backups, and uninstall controls.
- Token and time visibility per worker and per run (`turns` table; context snapshots vs per-turn usage, unknown shown
  as "—", never dollars).
- GitHub-style merge diff (diff2html + highlight.js): file list with +/− bars, collapsible files, Unified/Split toggle,
  dark/light themes; loaded lazily and kept mounted across tab redraws.
- Post-merge cleanup: archive/delete a writer's worktree project or a read-only worker's session, bulk archive and
  delete-merged-branches when a run ends (needs the fork's plugin project/session actions; a sidebar hint otherwise).
- `end_agent`, and an end-to-end acceptance script (`scripts/e2e.mjs`) with a browser checklist (`docs/ACCEPTANCE.md`).

### Changed

- Run-scoped worktree/branch identities and safer worker capacity/termination behavior improve reliability.
- Registration and configuration failures are visible through the tab and diagnostics.
- "Waiting on agents" cards show only the workers that wait targets; others are folded away.
- Ending a run is a persisted stop barrier serialized with merges; a merge gate is approved only when the merge lands
  (otherwise `failed`); runs stuck in "Ending…" are shown and retried.

## [0.2.0]

### Added

- Swimlane timeline for agents, messages, events, and gates.
- Inline plan and merge approvals, including MCP elicitation for supported Claude sessions.
- Long-polling `wait_for_agents` orchestration.
- Live CoAgent chat tool cards through CloudCLI's optional `toolRenderers` extension.

## [0.1.0]

### Added

- Initial CloudCLI plugin with a SQLite broker, MCP shim, Claude/Codex workers, git worktrees, and plan/merge gates.

