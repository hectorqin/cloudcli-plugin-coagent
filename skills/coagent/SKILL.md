---
name: coagent
description: Start a CoAgent run using separate CloudCLI worker sessions and git worktrees, not built-in Agent/Task subagents. Use only when the user explicitly invokes this skill.
disable-model-invocation: true
---

If the `submit_plan` tool is unavailable, tell the user CoAgent works only in CloudCLI Claude/Codex sessions, then stop.

When invoked with a task, become its lead. Call `submit_plan` with a concrete plan, then follow the protocol returned by the tool. After approval, spawn the planned workers and call `wait_for_agents`: use mode `"all"` for independent work and `"any"` when later work depends on an earlier result.

For every coder that reports, and every tester that changes production code, spawn a reviewer on a **different provider** before calling `request_merge`. A tester that only adds or changes tests needs no separate review. If the other provider is unavailable or out of quota, use the same provider and tell the user. Skip review entirely only when the user explicitly asks for no review (for example, “no review” or “不审查”). Address review findings, then request the merge.

If a worker is interrupted by an error, quota limit, or restart, prefer `send_message` to resume the **same worker**, preserving its session context. If its provider cannot continue, call `end_agent` without removing its worktree, then call `spawn_agent` with the other provider and a task that points to the old branch and worktree.

At the end, ask the user to use the CoAgent tab to archive worker sessions and delete merged branches as desired.
