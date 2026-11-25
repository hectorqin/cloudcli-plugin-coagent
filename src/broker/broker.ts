import crypto from 'node:crypto';
import type {
  AgentDTO, GateDTO, MessageDTO, Provider, RunDetailDTO, StateDTO, ToolRequest, ToolResponse,
} from '../shared/protocol.js';
import { SUPPORTED_PROVIDERS } from '../shared/protocol.js';
import type { CloudCli } from './cloudcli.js';
import type { GitOps } from './git.js';
import type { Prompts } from './prompts.js';
import type { Store } from './store.js';

export const MAX_WORKERS = 4;
/** Roles that only read. Every other role (including custom ones) writes and gets its own worktree. */
export const READONLY_ROLES = new Set(['planner', 'reviewer']);
export const DEFAULT_ROLE_PROVIDERS: Record<string, Provider> = {
  planner: 'claude', coder: 'claude', reviewer: 'codex', tester: 'claude',
};
const BACKOFF_MIN = 3_000;
/** A shim blocked on wait_for_agents/gate_wait polls every few seconds; it holds the lead's inbox while the lease is fresh. */
const LEASE_MS = 15_000;
/**
 * Lease on a message while a turn carries it. Renewed on every tick while the turn runs in this process, so an
 * expired lease means the process that dispatched it is gone.
 */
export const DISPATCH_LEASE_MS = 120_000;
const FINISHED_STATUSES = new Set(['idle', 'reported', 'merged', 'error', 'ended', 'interrupted']);
/** Statuses that never receive pushed turns (an interrupted worker waits for the lead to decide). */
const NO_DELIVERY = new Set(['merged', 'ended', 'interrupted']);
const ORPHAN_NOTE = 'Their turn may have partially executed (files half-edited, commands run), so their task was NOT '
  + 're-sent automatically.';

/** How often a worker whose turn outlived a broker restart is re-checked with CloudCLI. */
export const DETACHED_CHECK_MS = 30_000;
const GONE = new Set(['ended', 'merged']);
const ACTIVITY_KEEP = 12;
const repoMutexes = new Map<string, Promise<void>>();

/** Process-wide serialization for operations against the same git common directory. */
async function withRepoMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoMutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  repoMutexes.set(key, tail);
  await previous;
  try { return await fn(); } finally {
    release();
    if (repoMutexes.get(key) === tail) repoMutexes.delete(key);
  }
}

/**
 * Appends one activity line. Providers re-send the same tool call as it progresses (Codex: started → completed),
 * so an event with a known id replaces its earlier line, and an identical consecutive line is dropped.
 */
export function pushActivity(list: { ts: string; text: string; key?: string }[], event: Record<string, unknown>, text: string, ts: string) {
  const rawKey = event.toolId ?? event.toolCallId ?? event.itemId ?? event.id;
  const key = typeof rawKey === 'string' && rawKey ? rawKey : undefined;
  const next = list.slice();
  const same = key ? next.findIndex((x) => x.key === key) : -1;
  if (same >= 0) next[same] = { ...next[same], text };
  else if (next.at(-1)?.text !== text) next.push({ ts, text, key });
  return next.slice(-ACTIVITY_KEEP);
}

/** One line describing a normalized CloudCLI run event, or null for events not worth showing. */
export function describeEvent(e: Record<string, unknown>): string | null {
  const clip = (v: unknown, n: number) => {
    const t = (typeof v === 'string' ? v : JSON.stringify(v ?? '')).replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  if (e.kind === 'tool_use' && typeof e.toolName === 'string') {
    const input = (e.toolInput ?? {}) as Record<string, unknown>;
    const detail = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description ?? input.query ?? '';
    const name = e.toolName.replace(/^mcp__([^_]+(?:_[^_]+)*)__/, '');
    return detail ? `${name}: ${clip(detail, 90)}` : name;
  }
  if (e.kind === 'text' && e.role === 'assistant' && typeof e.content === 'string' && e.content.trim()) {
    return clip(e.content, 140);
  }
  return null;
}
const BACKOFF_MAX = 60_000;

export interface BrokerDeps {
  store: Store;
  cloudcli: CloudCli;
  git: GitOps;
  prompts: Prompts;
  setupInfo?: () => Record<string, string>;
  now?: () => number;
  log?: (...args: unknown[]) => void;
}

class ToolError extends Error {}
const fail = (msg: string): never => { throw new ToolError(msg); };
const hex = (n: number) => crypto.randomBytes(n).toString('hex');
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) fail(`"${name}" is required`);
  return (v as string).trim();
};

export class Broker {
  private backoff = new Map<string, { until: number; ms: number }>();
  /** Agents whose MCP call is blocked waiting (agent id → lease expiry). Their inbox is not pushed as new turns. */
  private leases = new Map<string, number>();
  /** Leads currently inside wait_for_agents (for the timeline). */
  private waiting = new Set<string>();
  private inflight = new Set<Promise<unknown>>();
  /** Message ids carried by the turn this process is running for an agent. */
  private dispatches = new Map<string, number[]>();
  /** Workers whose turn outlived a broker restart (still processing in CloudCLI) → next status check time. */
  private detached = new Map<string, number>();
  private checkingDetached = false;
  private now: () => number;
  private log: (...args: unknown[]) => void;

  constructor(private d: BrokerDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => undefined);
  }

  // ── settings ──────────────────────────────────────────────────────
  roleProviders(): Record<string, Provider> {
    return { ...DEFAULT_ROLE_PROVIDERS, ...this.d.store.getJson<Record<string, Provider>>('roleProviders', {}) };
  }
  setRoleProviders(map: Record<string, string>) {
    for (const [role, p] of Object.entries(map)) {
      if (!SUPPORTED_PROVIDERS.includes(p as Provider)) fail(`unsupported provider "${p}" for role "${role}"`);
    }
    this.d.store.setJson('roleProviders', map);
  }

  // ── MCP tools ─────────────────────────────────────────────────────
  async handleTool(req: ToolRequest): Promise<ToolResponse> {
    try {
      const out = await this.dispatchTool(req);
      return typeof out === 'string' ? { ok: true, text: out } : { ok: true, ...out };
    } catch (e) {
      if (!(e instanceof ToolError)) this.log('tool error', req.tool, e);
      return { ok: false, text: e instanceof ToolError ? e.message : `internal error: ${(e as Error).message}` };
    }
  }

  private holdLease(agentId: string) { this.leases.set(agentId, this.now() + LEASE_MS); }
  private leased(agentId: string) { return (this.leases.get(agentId) ?? 0) > this.now(); }

  private async dispatchTool(req: ToolRequest): Promise<string | Omit<ToolResponse, 'ok'>> {
    const { store } = this.d;
    let me = this.identify(req);
    let preface = '';
    if (!me && (req.tool === 'submit_plan' || req.tool === 'spawn_agent')) {
      me = this.promote(req);
      const run = store.run(me.runId)!;
      preface = this.d.prompts.lead({ run_id: run.id, agent_id: me.id, max_workers: String(MAX_WORKERS) }) + '\n\n---\n\n';
    }
    if (!me) {
      fail('You are not part of a coagent run. A run starts when a session calls submit_plan (it becomes the lead).');
    }
    const agent = me!;
    const run = store.run(agent.runId)!;
    const lead = store.agent(run.leadAgentId)!;
    const isLead = agent.id === lead.id;
    const requireLead = () => { if (!isLead) fail(`Only the lead (${lead.id}) can call ${req.tool}.`); };
    const a = req.args;
    if (GONE.has(agent.status) && req.tool !== 'list_agents') {
      fail(`You (${agent.id}) are ${agent.status} and no longer take part in run ${run.id}. Stop working and END YOUR TURN.`);
    }

    switch (req.tool) {
      case 'submit_plan': {
        requireLead();
        const plan = str(a.plan, 'plan');
        const prev = store.pendingGate(run.id, 'plan', null);
        if (prev) store.decideGate(prev.id, 'rejected', 'superseded by a newer plan');
        const id = store.addGate(run.id, 'plan', agent.id, null, plan);
        store.setPlanStatus(run.id, 'pending');
        store.addEvent(run.id, agent.id, 'gate_opened', { gate: id, kind: 'plan' });
        return {
          text: `${preface}Plan submitted as gate #${id}. The user reviews it in the CoAgent tab. `
            + 'END YOUR TURN NOW; the decision will arrive as a new message.',
          gate: { id, kind: 'plan', title: `Approve the plan from ${agent.id}?`, body: plan },
        };
      }

      case 'spawn_agent': {
        requireLead();
        if (run.planStatus !== 'approved') {
          fail(`${preface}The plan must be approved before spawning (plan status: ${run.planStatus}). Call submit_plan first.`);
        }
        const role = str(a.role, 'role').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const task = str(a.task, 'task');
        const provider = (typeof a.provider === 'string' && a.provider ? a.provider : this.roleProviders()[role] ?? 'claude') as Provider;
        if (!SUPPORTED_PROVIDERS.includes(provider)) fail(`Unsupported provider "${provider}". Use one of: ${SUPPORTED_PROVIDERS.join(', ')}.`);
        const full = () => {
          const used = this.slotHolders(run.id);
          if (used.length >= MAX_WORKERS) {
            fail(`Worker limit reached (${MAX_WORKERS} in use: ${used.map((x) => `${x.id} ${x.status}`).join(', ')}). `
              + 'Merge the ones that are done, or end_agent the ones you no longer need.');
          }
        };
        full();
        const id = this.uniqueId(role, (x) => !!store.agent(x));
        let cwd = lead.cwd;
        let branch: string | null = null;
        let worktreePath: string | null = null;
        if (!READONLY_ROLES.has(role)) {
          try {
            ({ worktreePath, branch } = await this.d.git.createWorktree(lead.cwd, run.id, id));
          } catch (e) {
            fail(`Could not create a worktree for the ${role}: ${(e as Error).message.split('\n')[0]}`);
          }
          cwd = worktreePath!;
        }
        try {
          // Agent, spawn event and task message land together, before any dispatch: a crash after this point
          // leaves a queued task that is delivered (or recovered) like any other message.
          store.transaction(() => {
            full(); // re-checked: another spawn may have finished while the worktree was created
            store.createAgent({ id, runId: run.id, role, provider, cwd, branch, worktreePath, status: 'starting', task });
            store.addEvent(run.id, id, 'spawned', { by: lead.id, role, provider, branch });
            store.addMessage(run.id, lead.id, id, 'message', task);
          });
        } catch (e) {
          if (worktreePath) await this.d.git.discardWorktree(lead.cwd, worktreePath, branch!);
          throw e;
        }
        this.deliver(id);
        return `Spawned ${id} (role ${role}, provider ${provider}) in ${cwd}${branch ? ` on branch ${branch}` : ''}. `
          + 'Spawn any other workers you need, then call wait_for_agents (mode "all" for independent parallel tasks, '
          + '"any" when later steps depend on earlier results).';
      }

      case 'send_message': {
        const toRaw = str(a.to, 'to');
        const to = toRaw === 'lead' ? lead.id : toRaw;
        const target = store.agent(to);
        if (!target || target.runId !== run.id) fail(`No agent "${toRaw}" in this run. Use list_agents.`);
        if (target!.status === 'merged' || target!.status === 'ended') fail(`${to} is ${target!.status} and no longer receives messages.`);
        if (to === agent.id) fail('You cannot message yourself.');
        const wait = this.slotWait(target!);
        store.addMessage(run.id, agent.id, to, 'message', str(a.body, 'body'));
        this.resume(target!);
        this.kick();
        return `Message queued for ${to}. ${wait ?? `It is delivered when ${to} is idle (or when it calls read_inbox).`}`;
      }

      case 'read_inbox': {
        const msgs = store.undelivered(agent.id);
        store.markDelivered(msgs.map((m) => m.id));
        return msgs.length ? formatInbox(agent.id, msgs) : 'No new messages.';
      }

      case 'report_result': {
        if (isLead) fail('The lead reports to the user directly, not via report_result.');
        const summary = str(a.summary, 'summary');
        store.transaction(() => {
          store.updateAgent(agent.id, { result: summary, status: 'reported' });
          store.addMessage(run.id, agent.id, lead.id, 'result', summary);
          // The turn that carried its task has done its job: acknowledge it now, so a crash before the stream
          // closes can never re-send the task.
          store.completeDispatch(store.dispatching(agent.id).map((m) => m.id));
        });
        this.kick();
        return `Result sent to ${lead.id}. END YOUR TURN NOW. You may receive rework in this session later.`;
      }

      case 'request_merge': {
        requireLead();
        const wid = str(a.worker, 'worker');
        const w = store.agent(wid);
        if (!w || w.runId !== run.id) fail(`No worker "${wid}" in this run.`);
        if (!w!.branch || !w!.worktreePath) fail(`${wid} is a read-only role and has nothing to merge.`);
        if (w!.status === 'merged') fail(`${wid} is already merged.`);
        if (w!.status === 'ended') fail(`${wid} was ended.`);
        if (store.busy.has(wid)) fail(`${wid} is still running; wait for it to finish before requesting a merge.`);
        const existing = store.pendingGate(run.id, 'merge', wid);
        if (existing) return `Merge request for ${wid} is already pending as gate #${existing.id}. END YOUR TURN.`;
        const note = typeof a.note === 'string' && a.note.trim() ? a.note.trim() : (w!.result ?? '(no summary)');
        const worktreePath = w!.worktreePath!;
        await this.d.git.commitAll(worktreePath, `coagent: uncommitted work from ${w!.id}`);
        const snapshot = await this.d.git.mergeSnapshot(lead.cwd, worktreePath, w!.branch!);
        const id = store.addGate(run.id, 'merge', agent.id, wid, note, snapshot);
        store.addEvent(run.id, agent.id, 'gate_opened', { gate: id, kind: 'merge', subject: wid });
        return {
          text: `Merge request for ${wid} (${w!.branch} → your checked-out branch) submitted as gate #${id}. `
            + 'END YOUR TURN; the outcome arrives as a new message.',
          gate: { id, kind: 'merge', title: `Merge ${wid} (${w!.branch}) into ${lead.id}'s branch?`, body: note, snapshot },
        };
      }

      case 'wait_for_agents':
        requireLead();
        return this.waitForAgents(run.id, lead.id, a);

      case 'end_agent': {
        requireLead();
        const wid = str(a.worker, 'worker');
        const w = store.agent(wid);
        if (!w || w.runId !== run.id) fail(`No worker "${wid}" in this run.`);
        return this.endAgent(wid, a.remove_worktree === true, lead.id);
      }

      case 'gate_wait':
      case 'gate_decide': {
        requireLead();
        const gate = store.gate(Number(a.gate));
        if (!gate || gate.runId !== run.id) fail(`No gate #${String(a.gate)} in this run.`);
        if (req.tool === 'gate_decide' && gate!.status === 'pending') {
          await this.decideGate(gate!.id, a.approve === true, typeof a.comment === 'string' && a.comment.trim() ? a.comment.trim() : null);
        }
        this.holdLease(lead.id);
        // gate_decide always answers with the decision, even if a concurrent gate_wait poll already picked it up.
        const msg = store.undeliveredGateMessage(gate!.id) ?? (req.tool === 'gate_decide' ? store.lastGateMessage(gate!.id) : null);
        if (!msg) {
          return store.gate(gate!.id)!.status === 'pending'
            ? { text: 'Waiting for the user to decide.', pending: true }
            : `Gate #${gate!.id} is already ${store.gate(gate!.id)!.status}; its decision was delivered earlier.`;
        }
        store.markDelivered([msg.id]);
        return msg.body;
      }

      case 'list_agents': {
        const rows = store.agents(run.id).map((x) =>
          `- ${x.id}${x.id === agent.id ? ' (you)' : ''}: role=${x.role} provider=${x.provider} status=${x.status}`
          + `${store.busy.has(x.id) ? ' [running]' : ''} cwd=${x.cwd}${x.branch ? ` branch=${x.branch}` : ''}`);
        return `Run ${run.id} (plan: ${run.planStatus})\n${rows.join('\n')}`;
      }
    }
    return fail(`Unknown tool ${req.tool}`);
  }

  /**
   * Identity comes from what the shim observed (provider session id), never from the model.
   * `agent_id` is only used to bind a freshly spawned worker on its first call (before its provider id is known),
   * or as a last resort when the provider exposes no session id at all.
   */
  private identify(req: ToolRequest): AgentDTO | null {
    const { store, cloudcli } = this.d;
    const { provider, providerSessionId } = req.caller;
    const claimed = typeof req.args.agent_id === 'string' ? req.args.agent_id.trim() : '';
    const claimedAgent = claimed ? store.agent(claimed) : null;
    const claimedActive = claimedAgent && store.run(claimedAgent.runId)?.status === 'active' ? claimedAgent : null;

    if (provider && providerSessionId) {
      const known = store.agentByProviderSession(provider, providerSessionId);
      if (known) return known;
      if (!claimedActive) return null;
      if (claimedActive.provider !== provider) fail(`agent_id ${claimed} belongs to a ${claimedActive.provider} session.`);
      if (!claimedActive.providerSessionId) {
        store.updateAgent(claimedActive.id, { providerSessionId });
        return store.agent(claimedActive.id);
      }
      // Provider ids can be replaced on resume; accept the new one only if CloudCLI maps it to the same app session.
      const info = cloudcli.sessionByProviderId(providerSessionId);
      if (info && claimedActive.appSessionId && info.appSessionId === claimedActive.appSessionId) {
        store.updateAgent(claimedActive.id, { providerSessionId });
        return store.agent(claimedActive.id);
      }
      return fail(`agent_id ${claimed} does not match the calling session.`);
    }
    return claimedActive;
  }

  private promote(req: ToolRequest): AgentDTO {
    const { store, cloudcli } = this.d;
    const { provider, providerSessionId } = req.caller;
    if (!provider || !providerSessionId) {
      fail('Cannot identify the calling session, so it cannot become a lead. Lead from a CloudCLI Claude or Codex session.');
    }
    const info = cloudcli.sessionByProviderId(providerSessionId!);
    if (!info) fail('This session is not managed by CloudCLI, so coagent cannot deliver messages to it. Open it in CloudCLI first.');
    const projectPath = info!.projectPath || req.caller.cwd || fail('Cannot determine the project path of this session.');
    const runId = this.uniqueId('r', (x) => !!store.run(x));
    const leadId = this.uniqueId('lead', (x) => !!store.agent(x));
    store.transaction(() => {
      store.createRun(runId, leadId, projectPath);
      store.createAgent({
        id: leadId, runId, role: 'lead', provider: provider!, providerSessionId, appSessionId: info!.appSessionId,
        cwd: projectPath, status: 'lead',
      });
    });
    store.addEvent(runId, leadId, 'run_started', { provider });
    this.log('run started', runId, 'lead', leadId);
    return store.agent(leadId)!;
  }

  // ── user actions from the tab ─────────────────────────────────────
  async decideGate(gateId: number, approve: boolean, comment: string | null): Promise<GateDTO> {
    const { store, git } = this.d;
    const gate = store.gate(gateId) ?? fail(`No gate #${gateId}`);
    if (gate.status !== 'pending') fail(`Gate #${gateId} is already ${gate.status}.`);
    const run = store.run(gate.runId)!;
    if (run.status !== 'active') fail('This run has ended.');
    const lead = run.leadAgentId;
    const fb = comment ? `\n\nUser comment: ${comment}` : '';

    if (gate.kind === 'plan') {
      store.decideGate(gate.id, approve ? 'approved' : 'rejected', comment);
      store.setPlanStatus(run.id, approve ? 'approved' : 'rejected');
      store.addEvent(run.id, null, 'gate_decided', { gate: gate.id, kind: 'plan', status: approve ? 'approved' : 'rejected', comment });
      store.addMessage(run.id, null, lead, 'gate', approve
        ? `The user APPROVED your plan (gate #${gate.id}).${fb}\n\nProceed: spawn_agent for each sub-task, then wait_for_agents.`
        : `The user REJECTED your plan (gate #${gate.id}).${fb}\n\nRevise it and call submit_plan again.`, gate.id);
    } else {
      const w = store.agent(gate.subjectAgent!)!;
      if (!approve) {
        store.decideGate(gate.id, 'rejected', comment);
        store.addEvent(run.id, null, 'gate_decided', { gate: gate.id, kind: 'merge', subject: w.id, status: 'rejected', comment });
        store.addMessage(run.id, null, lead, 'gate', `The user REJECTED merging ${w.id} (gate #${gate.id}).${fb}`, gate.id);
      } else {
        const leadAgent = store.agent(lead)!;
        const snapshot = gate.snapshot ?? fail(`Merge gate #${gate.id} has no code snapshot; request_merge again.`);
        const repoKey = await git.commonDir(leadAgent.cwd);
        await withRepoMutex(repoKey, async () => {
          // A second concurrent approval can be waiting on this lock; honor the decision that got there first.
          if (store.gate(gate.id)?.status !== 'pending') return;
          if (store.busy.has(w.id)) fail(`${w.id} is still running; wait for it to finish before merging.`);
          const [workerHead, leadHead] = await Promise.all([git.resolve(w.worktreePath!, w.branch!), git.head(leadAgent.cwd)]);
          const moved = [workerHead !== snapshot.workerHead ? 'worker branch' : '', leadHead !== snapshot.leadHead ? 'lead branch' : ''].filter(Boolean);
          if (moved.length) {
            store.decideGate(gate.id, 'expired', comment);
            store.addEvent(run.id, null, 'gate_decided', { gate: gate.id, kind: 'merge', subject: w.id, status: 'expired', moved, comment });
            store.addMessage(run.id, null, lead, 'gate',
              `The merge gate for ${w.id} (#${gate.id}) EXPIRED because the ${moved.join(' and ')} moved after review. `
              + `Nothing was merged; call request_merge again to review the current code.${fb}`, gate.id);
            return;
          }
          const res = await git.merge(leadAgent.cwd, snapshot.workerHead, `coagent: merge ${w.branch} (${w.role} ${w.id})`);
          store.decideGate(gate.id, 'approved', comment);
          store.addEvent(run.id, null, 'gate_decided', { gate: gate.id, kind: 'merge', subject: w.id, status: 'approved', comment });
          store.addEvent(run.id, w.id, 'merge', res.ok
            ? { ok: true, commit: res.commit, branch: w.branch, snapshot: snapshot.workerHead }
            : { ok: false, reason: res.reason, conflicts: res.conflicts, branch: w.branch, snapshot: snapshot.workerHead });
          if (res.ok) {
            store.transaction(() => {
              store.updateAgent(w.id, { status: 'merged' });
              store.cancelQueued(w.id);
            });
            await git.removeWorktree(w.worktreePath!).catch((e) => this.log('worktree remove failed', e));
            store.updateAgent(w.id, { worktreePath: null });
            store.addMessage(run.id, null, lead, 'gate',
              `The user approved the merge of ${w.id}; merged reviewed commit ${snapshot.workerHead.slice(0, 10)} as ${res.commit.slice(0, 10)}. `
              + `Its worktree was removed; the branch is kept.${fb}`, gate.id);
          } else {
            store.addMessage(run.id, null, lead, 'gate',
              `The user approved merging ${w.id}, but the merge FAILED: ${res.reason}.`
              + (res.conflicts.length ? `\nConflicting files:\n${res.conflicts.map((f) => `- ${f}`).join('\n')}` : '')
              + `\nThe merge was aborted; nothing changed. Resolve it (e.g. send ${w.id} rework to rebase onto your branch, `
              + `or merge ${w.branch} yourself), then request_merge again.${fb}`, gate.id);
          }
        });
      }
    }
    this.kick();
    return store.gate(gate.id)!;
  }

  userMessage(agentId: string, body: string) {
    const { store } = this.d;
    const a = store.agent(agentId) ?? fail(`No agent ${agentId}`);
    if (store.run(a.runId)?.status !== 'active') fail('This run has ended.');
    if (a.status === 'merged' || a.status === 'ended') fail(`${a.id} is ${a.status} and no longer receives messages.`);
    const wait = this.slotWait(a);
    store.addMessage(a.runId, null, a.id, 'message', str(body, 'body'));
    this.resume(a);
    this.kick();
    return wait;
  }

  // ── worker slots ──────────────────────────────────────────────────
  /**
   * Whether a worker takes one of the MAX_WORKERS slots: it is working (or its turn outlived a restart), it is
   * interrupted, it has work queued or in flight, or it is a writer whose unmerged worktree could still be merged.
   * Finished read-only workers without pending messages, and ended/merged workers, hold none.
   */
  private holdsSlot(a: AgentDTO, countPending = true): boolean {
    if (a.role === 'lead' || GONE.has(a.status)) return false;
    if (a.busy || this.detached.has(a.id) || ['starting', 'running', 'interrupted'].includes(a.status)) return true;
    if (a.branch && a.worktreePath) return true;
    return countPending && this.d.store.pendingCount(a.id) > 0;
  }
  private slotHolders(runId: string, except?: string): AgentDTO[] {
    return this.d.store.agents(runId).filter((x) => x.id !== except && this.holdsSlot(x));
  }
  /** Rework for a worker that holds no slot needs a free one; null when it can be delivered as usual. */
  private slotWait(a: AgentDTO): string | null {
    if (a.role === 'lead' || this.holdsSlot(a, false)) return null;
    const used = this.slotHolders(a.runId, a.id);
    if (used.length < MAX_WORKERS) return null;
    return `All ${MAX_WORKERS} worker slots are in use (${used.map((x) => x.id).join(', ')}), so ${a.id} only starts on it `
      + 'once one frees up (merge or end_agent a worker). The message stays queued until then.';
  }

  /** A message to an interrupted worker is the decision to continue it in its session. */
  private resume(a: AgentDTO) {
    if (a.status !== 'interrupted') return;
    this.d.store.updateAgent(a.id, { status: 'idle' });
    this.d.store.addEvent(a.runId, a.id, 'recovered', { status: 'resumed' });
  }

  /**
   * Ends one worker (lead tool `end_agent`, or the user from the tab): it stops receiving messages and frees its
   * slot. Its worktree is only deleted when asked; its branch is always kept. `by` null = the user.
   */
  async endAgent(agentId: string, removeWorktree: boolean, by: string | null): Promise<string> {
    const { store, git } = this.d;
    const check = () => {
      const w = store.agent(agentId) ?? fail(`No agent ${agentId}`);
      const run = store.run(w.runId)!;
      if (run.status !== 'active') fail('This run has ended.');
      if (w.id === run.leadAgentId) fail('The lead cannot be ended this way; end the run instead.');
      if (GONE.has(w.status)) fail(`${w.id} is already ${w.status}.`);
      if (store.busy.has(w.id)) fail(`${w.id} is in the middle of a turn; wait for it to finish, then end it.`);
      return { w, run };
    };
    let { w } = check();
    if (removeWorktree && w.worktreePath) {
      // Never delete a worktree a session may still be writing to (e.g. a turn that outlived a broker restart).
      const processing = await this.processing(w);
      if (processing !== false) {
        fail(`Cannot delete the worktree of ${w.id}: ${processing ? 'its session is still running a turn in CloudCLI'
          : 'CloudCLI cannot confirm that its session is idle'}. End it without remove_worktree, or retry later.`);
      }
    }
    // Stop barrier: from here on (no await until it is persisted) nothing can start a new turn for it.
    const checked = check();
    w = checked.w;
    const { run } = checked;
    let cancelled = 0;
    store.transaction(() => {
      const gate = store.pendingGate(run.id, 'merge', w.id);
      if (gate) {
        store.decideGate(gate.id, 'rejected', `${w.id} was ended`);
        store.addEvent(run.id, by, 'gate_decided', { gate: gate.id, kind: 'merge', subject: w.id, status: 'rejected', comment: 'worker ended' });
      }
      store.updateAgent(w.id, { status: 'ended' });
      cancelled = store.cancelQueued(w.id);
      store.addEvent(run.id, w.id, 'agent_ended', { by: by ?? 'user', removeWorktree, cancelled });
      if (by === null) {
        store.addMessage(run.id, null, run.leadAgentId, 'system',
          `The user ended ${w.id}. It no longer receives messages and no longer counts as a worker.`);
      }
    });
    this.detached.delete(w.id);
    if (by === null) this.kick();

    let cleanup = '';
    if (removeWorktree && w.worktreePath) {
      try {
        await git.removeWorktree(w.worktreePath);
        store.updateAgent(w.id, { worktreePath: null });
        cleanup = ` Deleted its worktree; branch ${w.branch} is kept.`;
      } catch (e) {
        this.log('worktree remove failed', w.id, e);
        cleanup = ` It is ended, but deleting its worktree ${w.worktreePath} failed: ${(e as Error).message.split('\n')[0]}.`;
      }
    } else if (w.worktreePath) {
      cleanup = ` Its worktree ${w.worktreePath} and branch ${w.branch} are kept (not merged).`;
    }
    const dropped = cancelled ? ` ${cancelled} undelivered message(s) to it were cancelled.` : '';
    return `Ended ${w.id}; its worker slot is free.${dropped}${cleanup}`;
  }

  /** Whether the agent's CloudCLI session is running a turn. false also when it never had a session or a turn. */
  private async processing(a: AgentDTO): Promise<boolean | null> {
    const sid = a.appSessionId ?? a.providerSessionId;
    if (!sid) return this.d.store.everDispatched(a.id) ? null : false;
    return (await this.d.cloudcli.sessionStatus(sid)).processing;
  }

  private uniqueId(prefix: string, taken: (id: string) => boolean): string {
    for (let i = 0; i < 20; i++) {
      const id = `${prefix}-${hex(3)}`;
      if (!taken(id)) return id;
    }
    return fail(`could not allocate a unique id for ${prefix}`);
  }

  async endRun(runId: string, removeWorktrees: boolean) {
    const { store, git } = this.d;
    const run = store.run(runId) ?? fail(`No run ${runId}`);
    if (removeWorktrees) {
      for (const a of store.agents(run.id)) {
        if (a.worktreePath && a.status !== 'merged') {
          await git.removeWorktree(a.worktreePath).catch((e) => this.log('worktree remove failed', e));
          store.updateAgent(a.id, { worktreePath: null });
        }
      }
    }
    store.endRun(run.id);
    store.addEvent(run.id, null, 'run_ended', { removeWorktrees });
  }

  // ── state for the tab ─────────────────────────────────────────────
  state(appSessionId: string | null, runId: string | null): StateDTO {
    const { store, cloudcli } = this.d;
    const me = appSessionId ? store.agentByAppSession(appSessionId) : null;
    const showRun = runId ?? me?.runId ?? null;
    return {
      setup: { apiKeyConfigured: cloudcli.apiKeyConfigured(), registration: this.d.setupInfo?.() ?? {} },
      me: me?.id ?? null,
      current: showRun ? this.detail(showRun) : null,
      runs: store.runs().map((r) => ({
        ...r,
        agentCount: store.agents(r.id).length,
        pendingGates: store.gates(r.id).filter((g) => g.status === 'pending').length,
      })),
    };
  }

  detail(runId: string): RunDetailDTO | null {
    const { store } = this.d;
    const run = store.run(runId);
    return run
      ? { run, agents: store.agents(runId), messages: store.messages(runId), gates: store.gates(runId), events: store.events(runId) }
      : null;
  }

  // ── delivery ──────────────────────────────────────────────────────
  /** Schedules a delivery pass. Safe to call often. */
  kick() { this.track(Promise.resolve().then(() => this.tick())); }

  /** One delivery pass: push queued messages to every idle recipient. Also driven by a timer in server.ts. */
  async tick() {
    const { store } = this.d;
    // A wait whose shim stopped polling (tool call cancelled, client gone) ends in the timeline too.
    for (const leadId of [...this.waiting]) {
      if (this.leased(leadId)) continue;
      this.waiting.delete(leadId);
      const lead = store.agent(leadId);
      if (lead) store.addEvent(lead.runId, leadId, 'wait_end', { reason: 'abandoned' });
    }
    // Keep the leases of turns this process is carrying fresh; anything else past its lease is orphaned.
    const until = this.now() + DISPATCH_LEASE_MS;
    for (const ids of this.dispatches.values()) store.renewDispatch(ids, until);
    this.sweepOrphans();
    await this.checkDetached();
    for (const id of store.agentsWithUndelivered()) this.deliver(id);
  }

  /** Pushes an agent's queued messages as one turn if it can take one now (queued → dispatching). */
  private deliver(id: string) {
    const { store } = this.d;
    if (store.busy.has(id) || this.dispatches.has(id) || this.detached.has(id)) return;
    const b = this.backoff.get(id);
    if (b && b.until > this.now()) return;
    if (this.leased(id)) return; // its blocked tool call will hand these over
    const agent = store.agent(id);
    if (!agent || NO_DELIVERY.has(agent.status)) return;
    if (store.run(agent.runId)?.status !== 'active') return;
    const msgs = store.undelivered(id);
    if (!msgs.length) return;
    // Results wake the lead once, when no worker is still working. Anything needing a reaction
    // (user messages, gate decisions, failures, worker questions) goes out at once.
    if (agent.role === 'lead' && msgs.every((m) => m.kind === 'result') && this.activeWorkers(agent.runId).length) return;
    // Rework for a worker that held no slot waits for a free one.
    if (agent.role !== 'lead' && !this.holdsSlot(agent, false) && this.slotHolders(agent.runId, agent.id).length >= MAX_WORKERS) return;
    const claimed = new Set(store.claimForDispatch(msgs.map((m) => m.id), this.now() + DISPATCH_LEASE_MS));
    const batch = msgs.filter((m) => claimed.has(m.id));
    if (!batch.length) return;
    this.track(this.runTurn(agent, this.turnPrompt(agent, batch), batch.map((m) => m.id)));
  }

  /** A worker's first turn carries its task inside the rendered worker prompt; later turns are inbox batches. */
  private turnPrompt(agent: AgentDTO, batch: MessageDTO[]): string {
    const { store, prompts } = this.d;
    if (agent.role === 'lead' || batch[0].id !== store.firstMessageId(agent.id)) return formatInbox(agent.id, batch);
    const run = store.run(agent.runId)!;
    const prompt = prompts.worker(agent.role, {
      agent_id: agent.id, run_id: run.id, lead_id: run.leadAgentId, cwd: agent.cwd, task: agent.task ?? batch[0].body,
      branch_line: agent.branch ? ` (branch \`${agent.branch}\`)` : ' (shared with the lead; read-only)',
    });
    const rest = batch.slice(1);
    return rest.length ? `${prompt}\n\n---\n\n${formatInbox(agent.id, rest)}` : prompt;
  }

  /**
   * Messages left in `dispatching` by a process that is gone (lease expired, not carried by this process).
   * A worker's are closed, never re-sent: the turn that carried them may have acted on them, so retrying is the
   * lead's call. A lead's go back to the queue (known limitation: a lead turn cut off mid-way may repeat).
   */
  private sweepOrphans(): { requeued: MessageDTO[]; closed: MessageDTO[] } {
    const { store } = this.d;
    const mine = new Set([...this.dispatches.values()].flat());
    const orphans = store.expiredDispatches(this.now()).filter((m) => !mine.has(m.id));
    const leads = new Set(store.runs().map((r) => r.leadAgentId));
    const requeued = orphans.filter((m) => leads.has(m.to));
    const closed = orphans.filter((m) => !leads.has(m.to));
    store.markDelivered(closed.map((m) => m.id));
    store.requeue(requeued.map((m) => m.id));
    for (const [runId, ms] of groupBy(requeued, (m) => m.runId)) {
      store.addEvent(runId, null, 'recovered', { requeued: ms.map((m) => m.id) });
    }
    if (requeued.length || closed.length) this.log('recovered orphaned dispatches', { requeued: requeued.length, closed: closed.length });
    return { requeued, closed };
  }

  /**
   * Startup recovery (awaited by server.ts before serving). Nothing is in flight in this fresh process, so for each
   * worker still marked starting/running CloudCLI is asked whether its session is still processing:
   *  - false → `interrupted`: the lead decides (continue via send_message, or end_agent);
   *  - true  → stays `running`, detached from us: re-checked every DETACHED_CHECK_MS; its report_result still counts;
   *  - null (unknown) → `interrupted`, and end_agent refuses to delete its worktree until CloudCLI says idle.
   * Its in-flight messages are closed either way (never re-sent automatically). Orphaned lead dispatches whose
   * lease expired go back to the queue; younger ones are swept by later ticks.
   */
  async recover(): Promise<{ interrupted: string[]; detached: string[]; requeued: number[] }> {
    const { store } = this.d;
    const interrupted: { a: AgentDTO; known: boolean }[] = [];
    const detached: AgentDTO[] = [];
    for (const a of store.activeRunAgents()) {
      if (a.role === 'lead' || store.busy.has(a.id) || this.dispatches.has(a.id)) continue;
      const inFlight = store.dispatching(a.id);
      if (a.status !== 'starting' && a.status !== 'running') {
        store.markDelivered(inFlight.map((m) => m.id)); // e.g. reported before the stream closed
        continue;
      }
      // Spawned, but its first turn was never dispatched: nothing ran, so it is simply delivered later.
      if (a.status === 'starting' && !inFlight.length && !store.everDispatched(a.id)) continue;
      const processing = await this.processing(a);
      const now = store.agent(a.id)!;
      if (now.status !== a.status || store.busy.has(a.id)) continue; // changed while we asked
      const ids = inFlight.map((m) => m.id);
      if (processing === true) {
        store.transaction(() => {
          store.markDelivered(ids);
          if (a.status === 'starting') store.updateAgent(a.id, { status: 'running' });
          store.addEvent(a.runId, a.id, 'recovered', { status: 'detached', previous: a.status, messages: ids });
        });
        this.detached.set(a.id, this.now() + DETACHED_CHECK_MS);
        detached.push(a);
        continue;
      }
      store.transaction(() => {
        store.updateAgent(a.id, { status: 'interrupted' });
        store.markDelivered(ids);
        store.addEvent(a.runId, a.id, 'recovered', { status: 'interrupted', previous: a.status, messages: ids, sessionState: processing === false ? 'idle' : 'unknown' });
      });
      interrupted.push({ a, known: processing === false });
    }
    const runs = new Set([...interrupted.map((x) => x.a.runId), ...detached.map((a) => a.runId)]);
    for (const runId of runs) {
      const lead = store.run(runId)!.leadAgentId;
      const line = (a: AgentDTO, extra = '') =>
        `- ${a.id} (${a.role}, was ${a.status})${a.branch ? ` — branch ${a.branch}, worktree ${a.worktreePath}` : ''}${extra}`;
      const ints = interrupted.filter((x) => x.a.runId === runId);
      const dets = detached.filter((a) => a.runId === runId);
      const parts = ['The coagent broker restarted while these workers were in the middle of a turn.'];
      if (ints.length) {
        parts.push(`Interrupted (their session is no longer running a turn, or CloudCLI could not tell):\n${
          ints.map((x) => line(x.a, x.known ? '' : ' — session state unknown: its worktree cannot be deleted for now')).join('\n')}\n\n`
          + `${ORPHAN_NOTE} For each one, decide:\n`
          + '- continue or retry it in the same session: send_message it (e.g. "You were interrupted; check the state of '
          + 'your work and continue the task"), or\n'
          + '- stop it: end_agent it (add remove_worktree: true to also delete its unmerged worktree). This frees its slot.');
      }
      if (dets.length) {
        parts.push(`Still running in CloudCLI (the broker lost track of the turn but it continues):\n${dets.map((a) => line(a)).join('\n')}\n`
          + 'Their report_result still reaches you. If one ends without reporting, you will be told.');
      }
      store.addMessage(runId, null, lead, 'system', parts.join('\n\n'));
    }
    const { requeued } = this.sweepOrphans();
    if (interrupted.length || detached.length) {
      this.log('recovery', { interrupted: interrupted.map((x) => x.a.id), detached: detached.map((a) => a.id) });
    }
    this.kick();
    return { interrupted: interrupted.map((x) => x.a.id), detached: detached.map((a) => a.id), requeued: requeued.map((m) => m.id) };
  }

  /** Follows workers whose turn outlived a restart until CloudCLI reports their session idle. */
  private async checkDetached() {
    if (this.checkingDetached || !this.detached.size) return;
    this.checkingDetached = true;
    try {
      const { store } = this.d;
      for (const [id, due] of [...this.detached]) {
        if (due > this.now()) continue;
        const a = store.agent(id);
        if (!a || a.status !== 'running' || store.run(a.runId)?.status !== 'active') { this.detached.delete(id); continue; }
        const processing = await this.processing(a);
        if (processing !== false) { this.detached.set(id, this.now() + DETACHED_CHECK_MS); continue; }
        this.detached.delete(id);
        const now = store.agent(id)!;
        if (now.status !== 'running') continue; // it reported (or was ended) meanwhile
        store.transaction(() => {
          store.updateAgent(id, { status: 'idle' });
          store.addEvent(a.runId, id, 'recovered', { status: 'finished' });
          store.addMessage(a.runId, null, store.run(a.runId)!.leadAgentId, 'system',
            `${id}'s turn (still running when the broker restarted) has finished without report_result. `
            + `Check its work, then send_message it to continue or end_agent it.`);
        });
      }
    } finally {
      this.checkingDetached = false;
    }
  }

  private activeWorkers(runId: string): AgentDTO[] {
    const { store } = this.d;
    return store.agents(runId).filter((x) => x.role !== 'lead' && (store.busy.has(x.id) || !FINISHED_STATUSES.has(x.status)));
  }

  /**
   * One poll of wait_for_agents. The shim repeats it until `pending` is false, so the lead's tool call stays open
   * like a native subagent call. Returns at once on anything that needs the lead: a failure, a worker's question,
   * a user message or gate decision.
   */
  private waitForAgents(runId: string, leadId: string, a: Record<string, unknown>): string | Omit<ToolResponse, 'ok'> {
    const { store } = this.d;
    const mode = a.mode === 'any' ? 'any' : 'all';
    const workers = store.agents(runId).filter((x) => x.role !== 'lead');
    const wanted = Array.isArray(a.agents) ? a.agents.map(String).filter(Boolean) : [];
    for (const id of wanted) if (!workers.some((w) => w.id === id)) fail(`No worker "${id}" in this run.`);
    const targets = wanted.length
      ? workers.filter((w) => wanted.includes(w.id))
      : workers.filter((w) => store.busy.has(w.id) || !['merged', 'ended'].includes(w.status));
    const ids = new Set(targets.map((t) => t.id));
    const finished = (w: AgentDTO) => !store.busy.has(w.id) && FINISHED_STATUSES.has(w.status);

    if (!this.waiting.has(leadId)) {
      this.waiting.add(leadId);
      store.addEvent(runId, leadId, 'wait_start', { mode, agents: [...ids] });
    }
    this.holdLease(leadId);

    const inbox = store.undelivered(leadId);
    const urgent = inbox.some((m) => m.kind !== 'result');
    const newResults = inbox.filter((m) => m.kind === 'result' && m.from && ids.has(m.from));
    const allDone = targets.every(finished);
    const done = a.give_up === true || !targets.length || urgent || allDone || (mode === 'any' && newResults.length > 0);

    const status = targets.map((t) => `${t.id}: ${store.busy.has(t.id) ? 'working' : t.status}`).join(', ');
    if (!done) {
      return { text: `Waiting (${mode}) for ${status}.`, pending: true, progress: status };
    }

    this.waiting.delete(leadId);
    this.leases.delete(leadId);
    store.addEvent(runId, leadId, 'wait_end', { mode, reason: a.give_up ? 'timeout' : urgent ? 'urgent' : 'done' });
    store.markDelivered(inbox.map((m) => m.id));
    const still = targets.filter((t) => !finished(t)).map((t) => t.id);
    const tail = still.length
      ? `\n\nStill working: ${still.join(', ')}. Call wait_for_agents again to keep waiting.`
      : '\n\nNo targeted worker is still working.';
    if (!targets.length && !inbox.length) return 'There are no active workers to wait for.';
    if (a.give_up === true && !inbox.length) return `Stopped waiting after the time limit. Status: ${status}.${tail}`;
    return `${inbox.length ? formatInbox(leadId, inbox) : 'No new messages.'}${tail}`;
  }

  /** Waits for every pending dispatch and delivery (used by tests and shutdown). */
  async settle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<unknown>) {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /**
   * Sends one turn carrying the claimed (dispatching) messages `msgIds` to an agent's session through CloudCLI.
   * They become delivered when the turn was accepted and finished, and go back to the queue otherwise.
   */
  private async runTurn(agent: AgentDTO, message: string, msgIds: number[]): Promise<boolean> {
    const { store, cloudcli } = this.d;
    if (store.busy.has(agent.id)) { store.requeue(msgIds); return false; }
    store.busy.add(agent.id);
    this.dispatches.set(agent.id, msgIds);
    const isLead = agent.role === 'lead';
    if (!isLead) store.updateAgent(agent.id, { status: 'running' });
    let res;
    let started = false;
    try {
      res = await cloudcli.send(
        { projectPath: agent.cwd, provider: agent.provider, sessionId: agent.appSessionId ?? agent.providerSessionId, message },
        (appId) => {
          // CloudCLI only announces the session once it accepted the run, so a 409 never opens a turn.
          started = true;
          store.addEvent(agent.runId, agent.id, 'turn_start', {});
          if (!agent.appSessionId) store.updateAgent(agent.id, { appSessionId: appId });
        },
        (event) => {
          const text = describeEvent(event);
          if (!text) return;
          store.activity.set(agent.id, pushActivity(store.activity.get(agent.id) ?? [], event, text, new Date(this.now()).toISOString()));
        },
      );
    } catch (e) {
      res = { status: 'error' as const, error: (e as Error).message };
    } finally {
      store.busy.delete(agent.id);
      this.dispatches.delete(agent.id);
    }
    // Once CloudCLI accepted the turn the agent has seen the messages and may have acted on them: never re-send
    // them automatically. Only a 409 or an error before acceptance puts them back in the queue.
    if (res.status === 'ok' || started) store.completeDispatch(msgIds);
    else store.requeue(msgIds);
    if (started || res.status === 'ok') {
      store.addEvent(agent.runId, agent.id, 'turn_end', res.status === 'error' ? { ok: false, error: res.error } : { ok: true });
    }
    const now = store.agent(agent.id)!;

    if (res.status === 'busy') {
      const prev = this.backoff.get(agent.id)?.ms ?? 0;
      const ms = Math.min(BACKOFF_MAX, prev ? prev * 2 : BACKOFF_MIN);
      this.backoff.set(agent.id, { until: this.now() + ms, ms });
      if (!isLead && now.status === 'running') store.updateAgent(agent.id, { status: 'idle' });
      return false;
    }
    if (res.status === 'error') {
      this.log('turn failed', agent.id, res.error);
      const prev = this.backoff.get(agent.id)?.ms ?? 0;
      const ms = Math.min(BACKOFF_MAX, prev ? prev * 2 : BACKOFF_MIN);
      this.backoff.set(agent.id, { until: this.now() + ms, ms });
      const keep = isLead || now.status === 'ended' || now.status === 'interrupted';
      store.updateAgent(agent.id, { lastError: res.error, ...(keep ? {} : { status: 'error' }) });
      if (!isLead) {
        store.addMessage(agent.runId, null, store.run(agent.runId)!.leadAgentId, 'system', `${agent.id} failed: ${res.error}`);
      }
      this.kick();
      return false;
    }

    this.backoff.delete(agent.id);
    if (res.appSessionId && !now.appSessionId) store.updateAgent(agent.id, { appSessionId: res.appSessionId });
    const appId = res.appSessionId ?? now.appSessionId;
    if (!now.providerSessionId && appId) {
      const info = cloudcli.sessionByAppId(appId);
      if (info?.providerSessionId) store.updateAgent(agent.id, { providerSessionId: info.providerSessionId });
    }
    if (!isLead && now.status === 'running') store.updateAgent(agent.id, { status: 'idle', lastError: null });
    this.kick();
    return true;
  }
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

export function formatInbox(agentId: string, msgs: MessageDTO[]): string {
  const parts = msgs.map((m) => `### From ${m.from ?? 'user'} · ${m.kind}\n${m.body}`);
  return `[coagent] ${msgs.length} new message(s) for ${agentId}:\n\n${parts.join('\n\n')}`;
}
