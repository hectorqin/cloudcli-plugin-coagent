---
name: coagent
description: Start a CoAgent run using separate CloudCLI worker sessions and git worktrees, not built-in Agent/Task subagents. Use only when the user explicitly invokes this skill.
disable-model-invocation: true
---

If the `submit_plan` tool is unavailable, tell the user CoAgent works only in CloudCLI Claude/Codex sessions, then stop.

When invoked with a task, become its lead. Call `submit_plan` with a concrete plan, then follow the protocol returned by the tool. After approval, spawn the planned workers and call `wait_for_agents`: use mode `"all"` for independent work and `"any"` when later work depends on an earlier result.

For every coder that reports, and every tester that changes production code, call `request_review`; it handles cross-provider selection, structured findings, rework, and reviewer cleanup. Request another round after rework, then merge only after a pass. Use `skip_review: true` with a recorded reason only when the user explicitly asks for no review.

If a worker is **paused** by a usage or rate limit, the broker resumes the same worker in its own session when the quota resets; usually just call `wait_for_agents` again. If a worker is interrupted by an error or restart, prefer `send_message` to resume the **same worker**, preserving its session context. If its provider cannot continue, call `handoff_agent` with the other provider (and any review feedback as `note`): it moves the work, including uncommitted changes, to a new worker of the same role and ends the old one.

Worker reports arrive as compact summaries. Use `get_result(worker)` only when the full details are needed. `list_agents`
hides merged and ended workers by default; pass `include_finished: true` for history. Reported read-only workers auto-end
to free their slot and are reopened automatically if you send them rework.

At the end, ask the user to use the CoAgent tab to archive worker sessions and delete merged branches as desired.
