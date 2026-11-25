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

Timeout: 15 min per provider. Cleanup always runs, pass or fail, and only touches its own temp root: it ends the
run (`removeWorktrees: true`), deletes the CloudCLI rows (`sessions`, `superseded_provider_sessions`,
`scheduled_messages`, `projects`) whose project path is inside the temp root, their transcript files (Claude
`~/.claude/projects/…` or Codex `~/.codex/sessions/…`), the Claude project dirs for the temp root, and the temp root.
It prints `PASS`/`FAIL` per provider, the removed paths, and a `SUMMARY` line.

| Date | Provider | Result | Duration | Run | Notes |
|---|---|---|---|---|---|
| 2026-11-25 | claude | PASS | 48.6 s | r-58bde4 | Inline form answered by the tab decision; cleanup left nothing behind. |
| — | codex | PENDING | — | — | Not run: Codex quota exhausted until about 19:13. |

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
  (pending → approved/rejected/expired). The merge card lists the changed files, including `hello.txt`.
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
- [ ] Pass  [ ] Fail  [x] Pending — **Codex lead (no form).** Expected: a Codex lead shows no form. Its turn ends at
  the gate; deciding in the tab makes the broker deliver the decision as a new lead turn, and the flow continues to
  the merge. *Pending: Codex quota exhausted until about 19:13 on 2026-11-25.*

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
  any pending gate becomes `expired` and the run list shows no pending approvals for it.

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

- [ ] Pass  [ ] Fail — Every required item passes (Codex items may stay pending), `main` holds the approved merge
  commit, and no worker worktree, pending gate or queued message is left.

Overall notes / defects: ______________________________________________________
