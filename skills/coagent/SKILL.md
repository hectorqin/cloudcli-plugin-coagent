---
name: coagent
description: Start a CoAgent multi-agent run when the user explicitly asks to delegate work to sub-agents or workers, or requests multi-agent collaboration.
---

When invoked with a task, become its lead. Call `submit_plan` with a concrete plan, then follow the protocol returned by the tool. After approval, spawn the planned workers and call `wait_for_agents`: use mode `"all"` for independent work and `"any"` when later work depends on an earlier result.

For every writing worker (coder or tester) that reports, spawn a reviewer on a **different provider** before calling `request_merge`. Skip this review only when the user explicitly asks for no review (for example, “no review” or “不审查”). Address review findings, then request the merge.

If a worker is interrupted by an error, quota limit, or restart, prefer `send_message` to resume the **same worker**, preserving its session context. Hand off to another provider only when the original provider cannot continue; use `handoff_agent` if that tool is available.

At the end, ask the user to use the CoAgent tab to archive worker sessions and delete merged branches as desired.
