# Screenshots for the upstream CloudCLI PRs

Taken on 2026-11-26 from a temporary, isolated CloudCLI instance running the fork build `v1.37.10-coagent.3`, with the CoAgent plugin v0.3.0. The data comes from one real coagent run: a Claude lead delegated "add a slugify() util with tests" to a Codex coder and a Claude reviewer in a throwaway repo at `/tmp/coagent-demo/acme-app`. The demo account is `demo`. Screenshots are 1440×900 with the dark theme unless noted.

| File | PR | Caption |
| --- | --- | --- |
| `01-sidebar-worktrees.png` | 1 | The coder's git worktree project (`coagent-r-5eb317-…`) is nested under its repository `acme-app` in the sidebar. |
| `01b-sidebar-after-archive.png` | 1, 4 | The same sidebar after the worktree project was archived from the chat card: the worktree row is gone and the repository stays. |
| `02-tool-cards.png` | 2 | coagent tool calls rendered as cards: plan approval, compact "Spawned" lines, a finished "Waiting on agents" card, and a live one that streams the reviewer's current activity. |
| `02b-merge-diff.png` | 2 | The merge approval card (approved) with its diff panel open, in unified view. |
| `02c-merge-approval-pending.png` | 2 | The merge approval card while it is pending, with the inline approval form below it. |
| `02d-tool-cards-light.png` | 2 | Light theme: the wait card, the merge card and the lead's final summary. |
| `03-api-docs-permissionmode.png` | 3 | The `permissionMode` row in `/api-docs.html` (orange outline added for the screenshot), under the `unattended` row. |
| `capabilities.txt` | 3 | Transcript of `GET /api/agent/capabilities`. The key is replaced by `ck_xxx` and the host shown is the default port. |
| `04-archive-actions.png` | 4 | After the merge, the worker cards offer "Archive worker session" and "Delete". |
| `04b-archived.png` | 4 | After clicking "Archive worker session" on the merge card: the card reads "Archived" and the worktree project is gone from the sidebar. |
| `05-inline-approval-form.png` | extra | The inline approval form (MCP elicitation) in the lead chat while the plan gate is pending. |
| `06-coagent-timeline.png` | extra | The CoAgent tab timeline for the run while the merge gate waits for review. |
