# Acceptance checklist

Two parts: an automated end-to-end run against the real CloudCLI (`scripts/e2e.mjs`), and a browser checklist for
the things only a person can see. Use the CloudCLI fork build named in `README.md`
(`coagent/v1.37.10-coagent.2`) with the current CoAgent plugin installed.

## Part 1 — automated end-to-end (`scripts/e2e.mjs`)

Hand-run, not part of CI. It creates live sessions, so it needs a running CloudCLI on `127.0.0.1:3001`, a running
broker (`~/.cloudcli-coagent/runtime.json`) and the plugin's saved API key. It never prints the key or model output.

```sh
node scripts/e2e.mjs --provider claude   # or: --provider codex; no flag runs both
```

For each provider it creates a fresh git repo under `os.tmpdir()/coagent-e2e-<provider>-*`, starts a lead through
`POST /api/agent` and asks it to delegate "add `hello.txt` containing `hello from coagent`" to one coder
(`submit_plan` → `spawn_agent` → `wait_for_agents` → `request_merge`). It approves both gates through the tab
endpoint after they have been pending for 4 s, checks that the merge gate diff mentions `hello.txt`, then asserts:

- `hello.txt` is on `main`, brought in by a merge commit; exactly one worker, status `merged`, worktree gone (DB and disk);
- the timeline has `run_started`, `gate_opened`, `gate_decided`, `spawned`, `turn_start`, `turn_end`, `wait_start`,
  `wait_end`, `merge`; both gates approved; no message left `queued` or `dispatching`.

Timeout: 15 min per provider. Cleanup (`scripts/e2e-cleanup.mjs`, unit-tested in `test/e2e-cleanup.test.ts`) always
runs, pass or fail, from the moment the temp root exists, and only touches that root:

1. It ends every coagent run whose project is inside the root (`removeWorktrees: true`). It then requires each end
   to succeed with no kept worktree, the run to read back as ended, and every session involved to be idle
   according to CloudCLI (`GET /api/agent/sessions/:id`, waiting up to 60 s for a finishing turn).
2. If anything is uncertain, it deletes nothing. It prints `CLEANUP INCOMPLETE` with the problems and manual
   steps, and exits non-zero.
3. It then validates every deletion target up front (transcripts, artifact dirs, project dirs, the root). If any
   target is invalid, it deletes nothing, as in step 2.
4. Otherwise it deletes the CloudCLI rows (`sessions`, `superseded_provider_sessions`, `scheduled_messages`,
   `projects`) whose project path is inside the root, and the exact transcript files named by those rows or by the
   run's own Claude agents. A Claude project dir is removed only if no file is left in it. It never scans by name
   prefix and never follows a symlink. Finally it removes the root. Each target is checked again right before it
   goes. The rows are deleted in one transaction, only if their project and transcript paths are unchanged, and
   committed after the files. Any change found on the way rolls the rows back and reports the cleanup as incomplete.

It prints `PASS`/`FAIL` per provider, the removed and kept paths, and a `SUMMARY` line.

| Date | Provider | Result | Duration | Run | Notes |
|---|---|---|---|---|---|
| 2026-11-25 | claude | PASS | 48.6 s | r-58bde4 | Inline form answered by the tab decision; cleanup left nothing behind. |
| 2026-11-26 | codex | PASS | 86.7 s | r-3c6cd7 | No inline form. Each tab decision reached the lead as a new broker-delivered turn (`turn_start` right after `gate_decided`). Cleanup left nothing behind. |
| 2026-11-26 | claude | PASS | 50.5 s | r-945c91 | Re-run to verify the rewritten cleanup. It kept the lead's Claude project dir because Claude Code had left an empty `memory/` folder in it; that case is now handled, and I removed the dir by hand. |

## Part 2 — browser checklist

Open a git-backed project and run one Claude lead through plan approval, one coder, `wait_for_agents` and merge
approval (the same task as Part 1 is fine). Keep the lead chat, the CoAgent tab and the sidebar visible.

- CloudCLI build: ____________________
- CoAgent version/commit: ____________________
- Browser and OS: ____________________

### Chat tool cards

- [ ] Pass  [ ] Fail — **Spawn card.** Expected: `spawn_agent` renders as a compact card naming the worker id, role
  and provider with its current status and an **Open ↗** button, not the raw MCP payload. **Open ↗** opens the
  worker's session.
- [ ] Pass  [ ] Fail — **Live wait card.** Expected: while `wait_for_agents` is blocked the card shows it is running
  and updates the worker status and up to three recent activity lines without a reload. When the worker reports,
  the card settles on the result.
- [ ] Pass  [ ] Fail — **Plan and merge cards.** Expected: `submit_plan` / `request_merge` cards show the gate state
  (pending → approved/rejected/expired/failed). The merge card lists the changed files, including `hello.txt`.
  A merge that git could not complete (conflict, dirty lead tree) shows `failed`, never `approved`.
- [ ] Pass  [ ] Fail — **Fallback.** Expected: with the stock (unpatched) CloudCLI, the same calls fall back to the
  default tool display and the flow still completes.

Notes: ______________________________________________________________________

### Inline approval and retraction

- [ ] Pass  [ ] Fail — **Inline form.** Expected: a Claude lead calling `submit_plan` or `request_merge` shows an
  inline Approve/Reject form with an optional comment in the chat. The tool call stays blocked until a decision.
- [ ] Pass  [ ] Fail — **Inline decision.** Expected: approving in the form unblocks the call. The CoAgent tab shows
  the gate as approved, and a comment typed in the form appears with the decision.
- [ ] Pass  [ ] Fail — **Tab wins, form retracts.** Expected: leave the form open and decide the same gate in the
  CoAgent tab. The chat form disappears promptly, the tool call completes once with the tab's decision, and no
  second decision is possible.
- [ ] Pass  [ ] Fail — **Codex lead (no form).** Expected: a Codex lead shows no form. Its turn ends at
  the gate; deciding in the tab makes the broker deliver the decision as a new lead turn, and the flow continues to
  the merge. *The broker side passed in Part 1 (2026-11-26); check
  here that the chat shows no form and the new turns appear in the lead's session.*

Notes: ______________________________________________________________________

### Sidebar worktree grouping

- [ ] Pass  [ ] Fail — **Active worker.** Expected: the coder's worktree appears indented under the main repository,
  not as an unrelated top-level project. Selecting it shows the worker session.
- [ ] Pass  [ ] Fail — **After merge.** Expected: once the worktree is removed, the worker session is still
  reachable under the main project and no orphan project appears.

Notes: ______________________________________________________________________

### Timeline

- [ ] Pass  [ ] Fail — **Lanes.** Expected: the leftmost lane is **You** (approvals and messages), then the lead, then
  one lane for the coder. Task and result messages connect the right lanes.
- [ ] Pass  [ ] Fail — **Bars and nodes.** Expected: broker-run turns show as bars from start to end; spawn, plan and
  merge gates, wait and merge appear in time order. A pending approval stays visible, and clicking an item opens
  its details (a merge gate shows its file list and unified diff).

Notes: ______________________________________________________________________

### Operations

- [ ] Pass  [ ] Fail — **Diagnostics.** Expected: **Diagnostics** shows broker, protocol and Node versions, DB schema
  health, CloudCLI reachability, MCP registration, run/agent counts by status, stuck busy agents (busy > 30 min)
  and undelivered message counts. It shows no API key, broker token or prompt text.
- [ ] Pass  [ ] Fail — **End agent.** Expected: an idle, unmerged worker's drawer shows **End agent**. Ending it asks
  whether to delete its worktree, frees its slot, rejects its pending merge request and tells the lead. Only that
  worker's worktree is removed; its branch is kept. Merged, ended or busy workers show no **End agent**.
- [ ] Pass  [ ] Fail — **End run.** Expected: ending the run (optionally deleting unmerged worktrees) marks it ended;
  any pending gate becomes `expired` and the run list shows no pending approvals for it. A lead waiting on a gate or
  in `wait_for_agents` is told the run ended. If a worker is still mid-turn, its worktree is kept (not deleted).
  While the stop is in progress, the run shows **Ending…**, and End run, approve/reject, messages and End agent are
  disabled. Diagnostics list the ending run with its age, and the broker finishes a stop stuck for over 30 s.

Notes: ______________________________________________________________________

### First-time setup (use a throwaway CloudCLI profile or remove the saved key first)

- [ ] Pass  [ ] Fail — **Setup only.** Expected: with no saved API key the tab shows only the API key setup form;
  no runs or agents are visible.
- [ ] Pass  [ ] Fail — **Save key.** Expected: pasting a valid CloudCLI API key and saving succeeds (the tab fetches a
  one-time setup nonce and sends it with the key), and the tab then shows runs. An invalid key is rejected with an
  error. The key does not appear in the UI, the tab's network responses or the broker log after saving.
- [ ] Pass  [ ] Fail — **Nonce is single-use (terminal).** Expected: with no key configured,
  `GET /setup/nonce` on the broker returns a nonce; `POST /setup` succeeds once with it, and the same nonce, a
  missing nonce or one older than 5 minutes gets `403`. Send the requests without an `Origin` header.

Notes: ______________________________________________________________________

## Final result

- [ ] Pass  [ ] Fail — Every required item passes, `main` holds the approved merge
  commit, and no worker worktree, pending gate or queued message is left.

Overall notes / defects: ______________________________________________________
