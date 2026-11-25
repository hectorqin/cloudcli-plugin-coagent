# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-11-25

### Added

- Crash recovery with leased message delivery and session-status-aware detached worker recovery.
- Merge review snapshots with immutable worker/lead commits, file statistics, and bounded unified diffs.
- Hardened loopback HTTP handling, setup nonces, data-file permissions, structured redacted logs, and diagnostics.
- Release CI, production-install smoke testing, version/manifest validation, migration backups, and uninstall controls.
- Token, duration, and usage visibility is in progress.

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

[0.3.0]: https://github.com/hectorqin/cloudcli-plugin-coagent/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hectorqin/cloudcli-plugin-coagent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hectorqin/cloudcli-plugin-coagent/releases/tag/v0.1.0
