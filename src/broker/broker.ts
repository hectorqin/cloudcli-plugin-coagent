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
const ACTIVE_WORKER = new Set(['starting', 'running', 'idle', 'reported']);
const BACKOFF_MIN = 3_000;
/** A shim blocked on wait_for_agents/gate_wait polls every few seconds; it holds the lead's inbox while the lease is fresh. */
const LEASE_MS = 15_000;
const FINISHED_STATUSES = new Set(['idle', 'reported', 'merged', 'error', 'ended']);
const ACTIVITY_KEEP = 12;

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
        const active = store.agents(run.id).filter((x) => x.id !== lead.id && ACTIVE_WORKER.has(x.status));
        if (active.length >= MAX_WORKERS) {
          fail(`Worker limit reached (${MAX_WORKERS} active: ${active.map((x) => x.id).join(', ')}). Merge or end some first.`);
        }
        const id = `${role}-${hex(2)}`;
        let cwd = lead.cwd;
        let branch: string | null = null;
        let worktreePath: string | null = null;
        if (!READONLY_ROLES.has(role)) {
          ({ worktreePath, branch } = await this.d.git.createWorktree(lead.cwd, id));
          cwd = worktreePath;
        }
        store.createAgent({ id, runId: run.id, role, provider, cwd, branch, worktreePath, status: 'starting', task });
        store.addEvent(run.id, id, 'spawned', { by: lead.id, role, provider, branch });
        const msgId = store.addMessage(run.id, lead.id, id, 'message', task);
        store.markDelivered([msgId], true);
        const prompt = this.d.prompts.worker(role, {
          agent_id: id, run_id: run.id, lead_id: lead.id, cwd, task,
          branch_line: branch ? ` (branch \`${branch}\`)` : ' (shared with the lead; read-only)',
        });
        this.track(this.runTurn(store.agent(id)!, prompt));
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
        store.addMessage(run.id, agent.id, to, 'message', str(a.body, 'body'));
        this.kick();
        return `Message queued for ${to}. It is delivered when ${to} is idle (or when it calls read_inbox).`;
      }

      case 'read_inbox': {
        const msgs = store.undelivered(agent.id);
        store.markDelivered(msgs.map((m) => m.id), true);
        return msgs.length ? formatInbox(agent.id, msgs) : 'No new messages.';
      }

      case 'report_result': {
        if (isLead) fail('The lead reports to the user directly, not via report_result.');
        const summary = str(a.summary, 'summary');
        store.updateAgent(agent.id, { result: summary, status: 'reported' });
        store.addMessage(run.id, agent.id, lead.id, 'result', summary);
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
        const existing = store.pendingGate(run.id, 'merge', wid);
        if (existing) return `Merge request for ${wid} is already pending as gate #${existing.id}. END YOUR TURN.`;
        const note = typeof a.note === 'string' && a.note.trim() ? a.note.trim() : (w!.result ?? '(no summary)');
        const id = store.addGate(run.id, 'merge', agent.id, wid, note);
        store.addEvent(run.id, agent.id, 'gate_opened', { gate: id, kind: 'merge', subject: wid });
        return {
          text: `Merge request for ${wid} (${w!.branch} → your checked-out branch) submitted as gate #${id}. `
            + 'END YOUR TURN; the outcome arrives as a new message.',
          gate: { id, kind: 'merge', title: `Merge ${wid} (${w!.branch}) into ${lead.id}'s branch?`, body: note },
        };
      }

      case 'wait_for_agents':
        requireLead();
        return this.waitForAgents(run.id, lead.id, a);

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
        store.markDelivered([msg.id], true);
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
    const runId = `r-${hex(3)}`;
    const leadId = `lead-${hex(2)}`;
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
        if (store.busy.has(w.id)) fail(`${w.id} is still running; wait for it to finish before merging.`);
        await git.commitAll(w.worktreePath!, `coagent: uncommitted work from ${w.id}`);
        const res = await git.merge(leadAgent.cwd, w.branch!, `coagent: merge ${w.branch} (${w.role} ${w.id})`);
        store.decideGate(gate.id, 'approved', comment);
        store.addEvent(run.id, null, 'gate_decided', { gate: gate.id, kind: 'merge', subject: w.id, status: 'approved', comment });
        store.addEvent(run.id, w.id, 'merge', res.ok
          ? { ok: true, commit: res.commit, branch: w.branch }
          : { ok: false, reason: res.reason, conflicts: res.conflicts, branch: w.branch });
        if (res.ok) {
          await git.removeWorktree(w.worktreePath!).catch((e) => this.log('worktree remove failed', e));
          store.updateAgent(w.id, { status: 'merged', worktreePath: null });
          store.addMessage(run.id, null, lead, 'gate',
            `The user approved the merge of ${w.id}; merged ${w.branch} as ${res.commit.slice(0, 10)}. `
            + `Its worktree was removed; the branch is kept.${fb}`, gate.id);
        } else {
          store.addMessage(run.id, null, lead, 'gate',
            `The user approved merging ${w.id}, but the merge FAILED: ${res.reason}.`
            + (res.conflicts.length ? `\nConflicting files:\n${res.conflicts.map((f) => `- ${f}`).join('\n')}` : '')
            + `\nThe merge was aborted; nothing changed. Resolve it (e.g. send ${w.id} rework to rebase onto your branch, `
            + `or merge ${w.branch} yourself), then request_merge again.${fb}`, gate.id);
        }
      }
    }
    this.kick();
    return store.gate(gate.id)!;
  }

  userMessage(agentId: string, body: string) {
    const { store } = this.d;
    const a = store.agent(agentId) ?? fail(`No agent ${agentId}`);
    if (store.run(a.runId)?.status !== 'active') fail('This run has ended.');
    store.addMessage(a.runId, null, a.id, 'message', str(body, 'body'));
    this.kick();
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
    for (const id of store.agentsWithUndelivered()) {
      if (store.busy.has(id)) continue;
      const b = this.backoff.get(id);
      if (b && b.until > this.now()) continue;
      if (this.leased(id)) continue; // its blocked tool call will hand these over
      const agent = store.agent(id);
      if (!agent || agent.status === 'merged' || agent.status === 'ended') continue;
      const msgs = store.undelivered(id);
      if (!msgs.length) continue;
      // Results wake the lead once, when no worker is still working. Anything needing a reaction
      // (user messages, gate decisions, failures, worker questions) goes out at once.
      if (agent.role === 'lead' && msgs.every((m) => m.kind === 'result') && this.activeWorkers(agent.runId).length) continue;
      store.markDelivered(msgs.map((m) => m.id), true);
      this.track(this.runTurn(agent, formatInbox(agent.id, msgs)).then((ok) => {
        if (!ok) store.markDelivered(msgs.map((m) => m.id), false);
      }));
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
    store.markDelivered(inbox.map((m) => m.id), true);
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

  /** Sends one turn to an agent's session through CloudCLI. Resolves true when the turn was accepted and finished. */
  private async runTurn(agent: AgentDTO, message: string): Promise<boolean> {
    const { store, cloudcli } = this.d;
    if (store.busy.has(agent.id)) return false;
    store.busy.add(agent.id);
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
    } finally {
      store.busy.delete(agent.id);
    }
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
      store.updateAgent(agent.id, { lastError: res.error, ...(isLead ? {} : { status: 'error' }) });
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

export function formatInbox(agentId: string, msgs: MessageDTO[]): string {
  const parts = msgs.map((m) => `### From ${m.from ?? 'user'} · ${m.kind}\n${m.body}`);
  return `[coagent] ${msgs.length} new message(s) for ${agentId}:\n\n${parts.join('\n\n')}`;
}
