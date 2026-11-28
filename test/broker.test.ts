import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Broker, ENDING_RETRY_MS, MAX_WORKERS } from '../src/broker/broker.js';
import { HttpCloudCli, type CloudCli, type SendInput, type SendResult, type SessionInfo } from '../src/broker/cloudcli.js';
import { Git } from '../src/broker/git.js';
import { filePrompts } from '../src/broker/prompts.js';
import { MIGRATIONS, pendingMigrations, Store } from '../src/broker/store.js';
import type { Caller, ToolName } from '../src/shared/protocol.js';
import { CLAUDE_TURN, CODEX_TURN, claudeBudget, codexBudget } from './fixtures/usage.js';

const PROMPTS = path.resolve(__dirname, '..', 'prompts');
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/** Stand-in for CloudCLI: records turns, hands out session ids, can be told to answer 409 or fail. */
class FakeCloudCli implements CloudCli {
  sessions = new Map<string, SessionInfo>(); // by provider id
  calls: SendInput[] = [];
  /** 'accepted-error': CloudCLI accepts the turn (session-id announced), then the run fails. */
  next: (SendResult['status'] | 'hold' | 'accepted-error')[] = [];
  /** App session ids CloudCLI is running a turn in (held turns). */
  live = new Set<string>();
  /** Overrides sessionStatus (e.g. null = host without the endpoint). */
  status: ((id: string) => boolean | null) | null = null;
  /** Releases for turns started with 'hold' (a worker that keeps working until released). */
  holds: (() => void)[] = [];
  /** Error text for the next 'error' / 'accepted-error' results (default: 'boom' / 'died mid-turn'). */
  errorText: string[] = [];
  /** A held turn ends with this error instead of ok when released (one per released turn, in order). */
  holdError: string[] = [];
  /** Stream events per accepted turn, emitted after the session id (one list per send, in order). */
  events: Record<string, unknown>[][] = [];
  /** capabilities().childSessions: true = the host nests child sessions; null = unknown (query failed). */
  childSessions: boolean | null = false;
  /** Parent stored per app session (like the fork's parent_session_id). */
  parents = new Map<string, string>();
  private n = 0;
  apiKeyConfigured() { return true; }
  verifyApiKey() { return true; }
  async saveApiKey() { /* not used */ }
  async send(input: SendInput, onApp?: (id: string) => void, onEvent?: (e: Record<string, unknown>) => void): Promise<SendResult> {
    this.calls.push(input);
    // Like the fork's /api/agent: a parent on continuation must equal the stored one, or the request is a 400.
    if (input.sessionId && input.parentSessionId && input.parentSessionId !== this.parents.get(input.sessionId)) {
      return { status: 'error', error: 'HTTP 400: parentSessionId cannot change', terminal: true };
    }
    let st = this.next.shift() ?? 'ok';
    if (st === 'busy') return { status: 'busy' };
    const script = this.events.shift() ?? [];
    const emit = () => { for (const e of script) onEvent?.(e); };
    if (st === 'hold') {
      let app0 = input.sessionId ?? null;
      if (!app0) {
        app0 = `app-${++this.n}`;
        this.sessions.set(`prov-${this.n}`, { appSessionId: app0, providerSessionId: `prov-${this.n}`, provider: input.provider, projectPath: input.projectPath });
      }
      onApp?.(app0);
      emit();
      this.live.add(app0);
      await new Promise<void>((r) => this.holds.push(r));
      this.live.delete(app0);
      const held = this.holdError.shift();
      return held ? { status: 'error', error: held, terminal: true } : { status: 'ok', appSessionId: app0 };
    }
    // Like HttpCloudCli: an HTTP failure or the error that ended the run is terminal.
    if (st === 'error') return { status: 'error', error: this.errorText.shift() ?? 'boom', terminal: true };
    let app = input.sessionId ?? null;
    if (!app) {
      app = `app-${++this.n}`;
      if (input.parentSessionId) this.parents.set(app, input.parentSessionId);
      this.sessions.set(`prov-${this.n}`, { appSessionId: app, providerSessionId: `prov-${this.n}`, provider: input.provider, projectPath: input.projectPath });
    }
    onApp?.(app);
    emit();
    if (st === 'accepted-error') return { status: 'error', error: this.errorText.shift() ?? 'died mid-turn', terminal: true };
    if (st === 'aborted') return { status: 'aborted', appSessionId: app };
    return { status: 'ok', appSessionId: app };
  }
  async sessionStatus(id: string) {
    return { processing: this.status ? this.status(id) : this.live.has(id) };
  }
  async capabilities() { return { sessionStatus: this.status ? null : true, childSessions: this.childSessions }; }
  sessionByProviderId(id: string) { return this.sessions.get(id) ?? null; }
  sessionByAppId(app: string) { return [...this.sessions.values()].find((s) => s.appSessionId === app) ?? null; }
}

let tmp: string;
let repo: string;
let store: Store;
let cc: FakeCloudCli;
let broker: Broker;
let clock: number;
const LEAD: Caller = { provider: 'claude', providerSessionId: 'lead-prov', cwd: null };

async function call(tool: ToolName, args: Record<string, unknown>, caller: Caller = LEAD) {
  const r = await broker.handleTool({ tool, args, caller });
  await broker.settle();
  return r;
}

async function startApprovedRun() {
  const r = await call('submit_plan', { plan: 'do the thing' });
  expect(r.ok).toBe(true);
  const gate = store.gates(store.runs()[0].id)[0];
  await broker.decideGate(gate.id, true, null);
  await broker.settle();
  return store.runs()[0];
}

async function spawn(role: string, task = 'write hello.txt', provider?: string) {
  const r = await call('spawn_agent', { role, task, ...(provider ? { provider } : {}) });
  expect(r.ok, r.text).toBe(true);
  const id = r.text.match(/Spawned (\S+)/)![1];
  return store.agent(id)!;
}

/** The worker's own MCP calls: bound on first use via agent_id, as a real fresh worker would be. */
const workerCaller = (provSession: string, provider: 'claude' | 'codex' = 'claude'): Caller =>
  ({ provider, providerSessionId: provSession, cwd: null });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-'));
  repo = path.join(tmp, 'proj');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  store = new Store(path.join(tmp, 'db.sqlite'));
  cc = new FakeCloudCli();
  cc.sessions.set('lead-prov', { appSessionId: 'lead-app', providerSessionId: 'lead-prov', provider: 'claude', projectPath: repo });
  clock = 1_000_000;
  broker = new Broker({ store, cloudcli: cc, git: Git, prompts: filePrompts(PROMPTS), now: () => clock });
});
afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('identity and promotion', () => {
  it('rejects tools from sessions outside any run', async () => {
    const r = await call('read_inbox', {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not part of a coagent run/);
  });

  it('submit_plan promotes the caller to lead and returns the lead protocol', async () => {
    const r = await call('submit_plan', { plan: 'p1' });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/You are now the LEAD/);
    const [run] = store.runs();
    expect(run.planStatus).toBe('pending');
    const lead = store.agent(run.leadAgentId)!;
    expect(lead).toMatchObject({ role: 'lead', appSessionId: 'lead-app', cwd: repo, providerSessionId: 'lead-prov' });
  });

  it('refuses to promote a session CloudCLI does not know', async () => {
    const r = await call('submit_plan', { plan: 'p' }, { provider: 'claude', providerSessionId: 'stranger', cwd: '/x' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not managed by CloudCLI/);
  });

  it('spawn_agent before plan approval fails but still promotes', async () => {
    const r = await call('spawn_agent', { role: 'coder', task: 't' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/plan must be approved/);
    expect(store.runs()).toHaveLength(1);
  });

  it('binds a worker on first call via agent_id, then rejects a forged claim from another session', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    const prov = store.agent(w.id)!.providerSessionId!; // filled from CloudCLI after the first turn
    expect(prov).toMatch(/^prov-/);

    expect((await call('list_agents', {}, workerCaller(prov))).text).toMatch(new RegExp(`${w.id} \\(you\\)`));
    const forged = await call('report_result', { summary: 'x', agent_id: w.id }, workerCaller('someone-else'));
    expect(forged.ok).toBe(false);
    expect(forged.text).toMatch(/does not match/);
  });

  it('binds a fresh worker whose provider id is not known yet (TOFU)', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    store.updateAgent(w.id, { providerSessionId: null });
    const r = await call('list_agents', { agent_id: w.id }, workerCaller('codex-thread-1'));
    expect(r.ok).toBe(true);
    expect(store.agent(w.id)!.providerSessionId).toBe('codex-thread-1');
  });
});

describe('plan gate and delivery', () => {
  it('delivers the approval to the lead session as a new turn', async () => {
    await startApprovedRun();
    const toLead = cc.calls.filter((c) => c.sessionId === 'lead-app');
    expect(toLead).toHaveLength(1);
    expect(toLead[0].projectPath).toBe(repo);
    expect(toLead[0].message).toMatch(/APPROVED your plan/);
  });

  it('re-queues on 409 and retries after backoff', async () => {
    await call('submit_plan', { plan: 'p' });
    cc.next.push('busy');
    await broker.decideGate(store.gates(store.runs()[0].id)[0].id, false, 'too vague');
    await broker.settle();
    const lead = store.runs()[0].leadAgentId;
    expect(store.undelivered(lead)).toHaveLength(1);

    await broker.tick(); await broker.settle();
    expect(cc.calls).toHaveLength(1); // still backing off

    clock += 10_000;
    await broker.tick(); await broker.settle();
    expect(cc.calls).toHaveLength(2);
    expect(cc.calls[1].message).toMatch(/REJECTED your plan[\s\S]*too vague/);
    expect(store.undelivered(lead)).toHaveLength(0);
  });

  it('read_inbox drains messages so they are not delivered twice', async () => {
    const run = await startApprovedRun();
    store.addMessage(run.id, null, run.leadAgentId, 'message', 'hello lead');
    const r = await call('read_inbox', {});
    expect(r.text).toMatch(/hello lead/);
    expect((await call('read_inbox', {})).text).toBe('No new messages.');
  });
});

describe('workers', () => {
  it('spawns a writing role in its own worktree with a rendered prompt', async () => {
    await startApprovedRun();
    const w = await spawn('coder', 'add hello.txt');
    expect(w.id).toMatch(/^coder-[0-9a-f]{6}$/);
    expect(w.branch).toBe(`coagent/${w.runId}/${w.id}`);
    expect(w.worktreePath).toBe(path.join(tmp, 'proj-worktrees', `coagent-${w.runId}-${w.id}`));
    expect(fs.existsSync(path.join(w.worktreePath!, 'README.md'))).toBe(true);
    const first = cc.calls.find((c) => c.projectPath === w.worktreePath)!;
    expect(first.sessionId ?? null).toBeNull();
    expect(first.message).toContain(`agent id: ${w.id}`);
    expect(first.message).toContain('add hello.txt');
    expect(first.message).toContain('COMMIT your work');
    expect(store.agent(w.id)).toMatchObject({ status: 'idle', appSessionId: expect.stringMatching(/^app-/) });
  });

  it('read-only roles share the lead directory and cannot be merged', async () => {
    await startApprovedRun();
    const r = await spawn('reviewer');
    expect(r).toMatchObject({ cwd: repo, branch: null, provider: 'codex' });
    expect((await call('request_merge', { worker: r.id })).text).toMatch(/read-only/);
  });

  it('enforces the worker limit', async () => {
    await startApprovedRun();
    for (let i = 0; i < MAX_WORKERS; i++) await spawn('coder'); // unmerged writers keep their slot
    const r = await call('spawn_agent', { role: 'planner', task: 't' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Worker limit/);
  });

  it('only the lead can spawn', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    const r = await call('spawn_agent', { role: 'coder', task: 't' }, workerCaller(w.providerSessionId!));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Only the lead/);
  });

  it('report_result reaches the lead as a new turn', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    const before = cc.calls.length;
    await call('report_result', { summary: 'done: wrote hello' }, workerCaller(w.providerSessionId!));
    expect(store.agent(w.id)!.status).toBe('reported');
    const turn = cc.calls.slice(before).find((c) => c.sessionId === 'lead-app')!;
    expect(turn.message).toMatch(new RegExp(`From ${w.id} · result[\\s\\S]*done: wrote hello`));
  });

  it('tells the lead when a worker turn fails', async () => {
    await startApprovedRun();
    cc.next.push('error');
    const r = await call('spawn_agent', { role: 'planner', task: 't' });
    expect(r.ok).toBe(true);
    const w = store.agents(store.runs()[0].id).find((a) => a.role === 'planner')!;
    expect(w).toMatchObject({ status: 'error', lastError: 'boom' });
    expect(cc.calls.at(-1)!.message).toMatch(/failed: boom/);
  });
});

describe('timeline events', () => {
  it('records run start, gates, spawns and paired turns; a 409 opens no turn', async () => {
    await call('submit_plan', { plan: 'p' });
    cc.next.push('busy');
    await broker.decideGate(store.gates(store.runs()[0].id)[0].id, true, null);
    await broker.settle();
    clock += 10_000;
    await broker.tick(); await broker.settle();
    await spawn('planner');
    const run = store.runs()[0];
    const types = store.events(run.id).map((e) => `${e.type}:${e.agentId ?? 'user'}`);
    expect(types).toEqual([
      `run_started:${run.leadAgentId}`, `gate_opened:${run.leadAgentId}`, 'gate_decided:user',
      `turn_start:${run.leadAgentId}`, `turn_end:${run.leadAgentId}`,
      expect.stringMatching(/^spawned:planner-/), expect.stringMatching(/^turn_start:planner-/), expect.stringMatching(/^turn_end:planner-/),
    ]);
  });
});

describe('merge gate', () => {
  it('commits leftovers at request time, records the snapshot, and merges its exact SHA', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'hello.txt'), 'hi\n'); // left uncommitted on purpose
    const r = await call('request_merge', { worker: w.id });
    expect(r.ok, r.text).toBe(true);
    expect(r.gate!.snapshot).not.toHaveProperty('diff');
    expect(r.gate!.snapshot).not.toHaveProperty('stat');
    expect(r.gate!.snapshot).not.toHaveProperty('nameStatus');
    const gate = store.gates(w.runId).find((g) => g.kind === 'merge')!;
    expect(sh(w.worktreePath!, 'status', '--porcelain')).toBe('');
    expect(gate.snapshot).toMatchObject({
      workerHead: sh(w.worktreePath!, 'rev-parse', 'HEAD'),
      leadHead: sh(repo, 'rev-parse', 'HEAD'),
      mergeBase: sh(repo, 'rev-parse', 'HEAD'),
      diffTruncated: false,
      files: [{ path: 'hello.txt', oldPath: null, status: 'A', additions: 1, deletions: 0, binary: false }],
    });
    expect(JSON.stringify(gate)).not.toContain('+hi');
    expect(store.gatePatch(gate.id)).toMatchObject({ stat: expect.stringContaining('hello.txt'), nameStatus: 'A\thello.txt', diff: expect.stringContaining('+hi') });
    expect(broker.gateDiff(gate.id)).toMatchObject({ gate: gate.id, diff: expect.stringContaining('+hi'), truncated: false });
    const queuedId = store.addMessage(w.runId, store.run(w.runId)!.leadAgentId, w.id, 'message', 'obsolete after merge');

    await broker.decideGate(gate.id, true, 'lgtm');
    await broker.settle();
    expect(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hi\n');
    expect(fs.existsSync(w.worktreePath!)).toBe(false);
    expect(sh(repo, 'branch', '--list', w.branch!)).toContain(w.branch!);
    expect(sh(repo, 'rev-parse', 'HEAD^2')).toBe(gate.snapshot!.workerHead);
    expect(store.agent(w.id)!.status).toBe('merged');
    expect(store.messages(w.runId).find((m) => m.id === queuedId)!.state).toBe('cancelled');
    expect(cc.calls.at(-1)!.message).toMatch(/approved the merge[\s\S]*lgtm/);
    const expectedSnapshot = gate.snapshot;
    store.close();
    store = new Store(path.join(tmp, 'db.sqlite')); // migrations are idempotent and the review survives restart
    expect(store.gate(gate.id)!.snapshot).toEqual(expectedSnapshot);
  });

  it('refuses to open a merge gate while the worker is busy', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    store.busy.add(w.id);
    const r = await call('request_merge', { worker: w.id });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/still running/);
    expect(store.gates(w.runId).filter((g) => g.kind === 'merge')).toHaveLength(0);
    store.busy.delete(w.id);
  });

  it('refuses to open a merge gate for an interrupted worker', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    store.updateAgent(w.id, { status: 'interrupted' });
    const r = await call('request_merge', { worker: w.id });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/interrupted/);
  });

  it('expires the gate when the worker HEAD moves after request and merges nothing', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'reviewed.txt'), 'reviewed\n');
    await call('request_merge', { worker: w.id });
    const gate = store.gates(w.runId).find((g) => g.kind === 'merge')!;
    fs.writeFileSync(path.join(w.worktreePath!, 'later.txt'), 'later\n');
    sh(w.worktreePath!, 'add', '-A');
    sh(w.worktreePath!, 'commit', '-q', '-m', 'later work');

    await broker.decideGate(gate.id, true, null);
    await broker.settle();
    expect(store.gate(gate.id)!.status).toBe('expired');
    expect(fs.existsSync(path.join(repo, 'reviewed.txt'))).toBe(false);
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(gate.snapshot!.leadHead);
    expect(fs.existsSync(w.worktreePath!)).toBe(true);
    expect(cc.calls.at(-1)!.message).toMatch(/EXPIRED because the worker branch moved[\s\S]*request_merge again/);
  });

  it('accepts a descendant lead HEAD and merges onto it', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'worker.txt'), 'worker\n');
    await call('request_merge', { worker: w.id });
    const gate = store.gates(w.runId).find((g) => g.kind === 'merge')!;
    fs.writeFileSync(path.join(repo, 'lead.txt'), 'lead\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'lead moved');

    await broker.decideGate(gate.id, true, null);
    await broker.settle();
    expect(store.gate(gate.id)!.status).toBe('approved');
    expect(fs.readFileSync(path.join(repo, 'worker.txt'), 'utf8')).toBe('worker\n');
    expect(fs.readFileSync(path.join(repo, 'lead.txt'), 'utf8')).toBe('lead\n');
  });

  it('expires when the worker has uncommitted changes after review and preserves its worktree', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'reviewed.txt'), 'reviewed\n');
    await call('request_merge', { worker: w.id });
    const gate = store.gates(w.runId).find((g) => g.kind === 'merge')!;
    fs.writeFileSync(path.join(w.worktreePath!, 'uncommitted.txt'), 'must survive\n');
    await broker.decideGate(gate.id, true, null);
    await broker.settle();
    expect(store.gate(gate.id)!.status).toBe('expired');
    expect(fs.readFileSync(path.join(w.worktreePath!, 'uncommitted.txt'), 'utf8')).toBe('must survive\n');
    expect(fs.existsSync(path.join(repo, 'reviewed.txt'))).toBe(false);
    expect(cc.calls.at(-1)!.message).toMatch(/EXPIRED because worker has uncommitted changes/);
    await broker.endAgent(w.id, false, null);
    expect(store.gate(gate.id)!.status).toBe('expired'); // already decided: endAgent must not rewrite it
  });

  it('marks binary files and truncates oversized unified diffs', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    fs.writeFileSync(path.join(w.worktreePath!, 'large.txt'), Buffer.alloc(65 * 1024 * 1024, 120));
    await call('request_merge', { worker: w.id });
    const snapshot = store.gates(w.runId).find((g) => g.kind === 'merge')!.snapshot!;
    expect(snapshot.files.find((f) => f.path === 'image.bin')).toMatchObject({ binary: true, additions: null, deletions: null });
    expect(snapshot.diffTruncated).toBe(true);
    const patch = store.gatePatch(store.gates(w.runId).find((g) => g.kind === 'merge')!.id)!;
    expect(patch.diff).toMatch(/Binary files .*image\.bin.* differ/);
    expect(Buffer.byteLength(patch.diff)).toBeLessThanOrEqual(200 * 1024);
  });

  it('serializes concurrent approvals in one repo and merges both reviewed commits', async () => {
    await startApprovedRun();
    const a = await spawn('coder', 'first');
    const b = await spawn('tester', 'second');
    fs.writeFileSync(path.join(a.worktreePath!, 'first.txt'), 'first\n');
    fs.writeFileSync(path.join(b.worktreePath!, 'second.txt'), 'second\n');
    await call('request_merge', { worker: a.id });
    await call('request_merge', { worker: b.id });
    const gates = store.gates(a.runId).filter((g) => g.kind === 'merge');

    let activeMerges = 0;
    let maxActiveMerges = 0;
    const instrumented = {
      ...Git,
      merge: async (...args: Parameters<typeof Git.merge>) => {
        activeMerges++;
        maxActiveMerges = Math.max(maxActiveMerges, activeMerges);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        try { return await Git.merge(...args); } finally { activeMerges--; }
      },
    };
    broker = new Broker({ store, cloudcli: cc, git: instrumented, prompts: filePrompts(PROMPTS), now: () => clock });
    await Promise.all(gates.map((g) => broker.decideGate(g.id, true, null)));
    await broker.settle();

    expect(maxActiveMerges).toBe(1);
    expect(store.gate(gates[0].id)!.status).toBe('approved');
    expect(store.gate(gates[1].id)!.status).toBe('approved');
    expect(fs.readFileSync(path.join(repo, 'first.txt'), 'utf8')).toBe('first\n');
    expect(fs.readFileSync(path.join(repo, 'second.txt'), 'utf8')).toBe('second\n');
  });

  it('reports when the lead HEAD changes between verification and git merge', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'worker.txt'), 'worker\n');
    await call('request_merge', { worker: w.id });
    const gate = store.gates(w.runId).find((g) => g.kind === 'merge')!;
    const racingGit = {
      ...Git,
      merge: async (...args: Parameters<typeof Git.merge>) => {
        fs.writeFileSync(path.join(repo, 'raced.txt'), 'raced\n');
        sh(repo, 'add', '-A');
        sh(repo, 'commit', '-q', '-m', 'outside mutex');
        return Git.merge(...args);
      },
    };
    broker = new Broker({ store, cloudcli: cc, git: racingGit, prompts: filePrompts(PROMPTS), now: () => clock });
    await broker.decideGate(gate.id, true, null);
    await broker.settle();
    expect(store.gate(gate.id)!.status).toBe('approved');
    expect(cc.calls.at(-1)!.message).toMatch(/WARNING: the lead HEAD changed during merge/);
    expect(fs.readFileSync(path.join(repo, 'worker.txt'), 'utf8')).toBe('worker\n');
    expect(fs.readFileSync(path.join(repo, 'raced.txt'), 'utf8')).toBe('raced\n');
  });

  it('preserves exact unquoted old and new paths for renames', async () => {
    const oldPath = 'old\té.txt';
    const newPath = 'new\té.txt';
    fs.writeFileSync(path.join(repo, oldPath), 'same\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'add unusual path');
    await startApprovedRun();
    const w = await spawn('coder');
    sh(w.worktreePath!, 'mv', oldPath, newPath);
    sh(w.worktreePath!, 'commit', '-q', '-m', 'rename unusual path');
    await call('request_merge', { worker: w.id });
    const file = store.gates(w.runId).find((g) => g.kind === 'merge')!.snapshot!.files[0];
    expect(file).toMatchObject({ status: expect.stringMatching(/^R/), oldPath, path: newPath });
  });

  it('expires a pre-upgrade merge gate without a snapshot', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    const gateId = store.addGate(run.id, 'merge', run.leadAgentId, w.id, 'legacy');
    await broker.decideGate(gateId, true, null);
    await broker.settle();
    expect(store.gate(gateId)!.status).toBe('expired');
    expect(cc.calls.at(-1)!.message).toMatch(/created before code snapshots were recorded[\s\S]*request_merge again/);
  });

  it('expires instead of throwing when the worker worktree is missing', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'worker.txt'), 'worker\n');
    await call('request_merge', { worker: w.id });
    const gate = store.gates(w.runId).find((g) => g.kind === 'merge')!;
    sh(repo, 'worktree', 'remove', '--force', w.worktreePath!);
    await broker.decideGate(gate.id, true, null);
    await broker.settle();
    expect(store.gate(gate.id)!.status).toBe('expired');
    expect(cc.calls.at(-1)!.message).toMatch(/worker branch or worktree is missing/);
  });

  it('aborts on conflict, keeps the worktree and reports the files', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'README.md'), 'worker\n');
    sh(w.worktreePath!, 'commit', '-qam', 'worker edit');
    fs.writeFileSync(path.join(repo, 'README.md'), 'lead\n');
    sh(repo, 'commit', '-qam', 'lead edit');

    await call('request_merge', { worker: w.id });
    const gate = store.gates(w.runId).find((g) => g.kind === 'merge')!;
    await broker.decideGate(gate.id, true, null);
    await broker.settle();
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('lead\n');
    expect(sh(repo, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(w.worktreePath!)).toBe(true);
    expect(cc.calls.at(-1)!.message).toMatch(/merge FAILED: merge conflict[\s\S]*- README.md/);
  });

  it('endRun can delete unmerged worktrees', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    await broker.endRun(run.id, true);
    expect(fs.existsSync(w.worktreePath!)).toBe(false);
    expect(store.run(run.id)!.status).toBe('ended');
    expect((await call('list_agents', {})).ok).toBe(false); // ended runs no longer resolve identities
  });

  it('deletes only merged worker branches, reports safe-delete skips, and rejects a non-lead caller', async () => {
    const run = await startApprovedRun();
    const gone = await spawn('coder');
    const checkedOut = await spawn('coder');
    const unmerged = await spawn('coder');
    const ended = await spawn('coder');
    for (const w of [gone, checkedOut]) {
      fs.writeFileSync(path.join(w.worktreePath!, `${w.id}.txt`), `${w.id}\n`);
      await call('request_merge', { worker: w.id });
      const gate = store.gates(run.id).findLast((g) => g.kind === 'merge' && g.subjectAgent === w.id)!;
      await broker.decideGate(gate.id, true, null);
      await broker.settle();
    }
    await broker.endAgent(ended.id, false, null);
    const checkout = path.join(tmp, 'checked-out-branch');
    // A failed automatic worktree cleanup already exercises this condition; otherwise check it out anew.
    if (!fs.existsSync(checkedOut.worktreePath!)) sh(repo, 'worktree', 'add', checkout, checkedOut.branch!);

    await expect(broker.deleteMergedBranches(run.id, unmerged.id)).rejects.toMatchObject({ code: 403 });
    const result = await broker.deleteMergedBranches(run.id, run.leadAgentId);
    expect(result.deleted).toEqual([{ agentId: gone.id, branch: gone.branch }]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: checkedOut.id, reason: expect.stringMatching(/checked out|worktree/i) }),
      expect.objectContaining({ agentId: unmerged.id, reason: 'worker is not merged' }),
      expect.objectContaining({ agentId: ended.id, reason: 'worker ended without being merged' }),
    ]));
    expect(sh(repo, 'branch', '--list', gone.branch!)).toBe('');
    expect(sh(repo, 'branch', '--list', checkedOut.branch!)).toContain(checkedOut.branch!);
    expect(store.events(run.id).at(-1)).toMatchObject({ type: 'branches_deleted', agentId: run.leadAgentId });
  });

  it('skips a formerly merged branch when the lead HEAD moved behind it', async () => {
    const run = await startApprovedRun();
    const base = sh(repo, 'rev-parse', 'HEAD');
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'moved.txt'), 'merged\n');
    await call('request_merge', { worker: w.id });
    await broker.decideGate(store.gates(run.id).find((g) => g.kind === 'merge')!.id, true, null);
    await broker.settle();
    sh(repo, 'checkout', '--detach', base);
    const result = await broker.deleteMergedBranches(run.id, run.leadAgentId);
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toContainEqual(expect.objectContaining({ agentId: w.id, reason: 'branch is not fully merged into the lead HEAD' }));
    expect(sh(repo, 'branch', '--list', w.branch!)).toContain(w.branch!);
  });

  it('deletes a merged worker branch while the lead itself is on a detached HEAD', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'detached.txt'), 'merged\n');
    await call('request_merge', { worker: w.id });
    await broker.decideGate(store.gates(run.id).find((g) => g.kind === 'merge')!.id, true, null);
    await broker.settle();
    sh(repo, 'checkout', '--detach', 'HEAD');
    const result = await broker.deleteMergedBranches(run.id, run.leadAgentId);
    expect(result.deleted).toEqual([{ agentId: w.id, branch: w.branch }]);
  });

  it('records workspace events only for canonical merged writer paths (ended writers may only be archived)', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    expect(() => broker.recordWorkspaceEvent(run.id, w.id, 'workspace_archived', 'project')).toThrow(/Only merged\/ended writer/);
    store.updateAgent(w.id, { status: 'merged' });
    expect(broker.recordWorkspaceEvent(run.id, w.id, 'workspace_deleted', 'project')).toEqual({ ok: true });
    store.updateAgent(w.id, { status: 'ended' });
    expect(broker.recordWorkspaceEvent(run.id, w.id, 'workspace_deleted', 'project')).toEqual({ ok: true });
    expect(broker.recordWorkspaceEvent(run.id, w.id, 'workspace_archived', 'project')).toEqual({ ok: true });
    store.updateAgent(w.id, { status: 'merged' });
    (store as unknown as { db: DatabaseSync }).db.prepare('UPDATE agents SET cwd = ? WHERE id = ?').run(repo, w.id);
    expect(() => broker.recordWorkspaceEvent(run.id, w.id, 'workspace_archived', 'project')).toThrow(/Only merged\/ended writer/);

    const ro = await spawn('reviewer');
    expect(ro.branch).toBeNull();
    expect(broker.recordWorkspaceEvent(run.id, ro.id, 'workspace_archived', 'session')).toEqual({ ok: true });
    expect(store.events(run.id).at(-1)).toMatchObject({ type: 'workspace_archived', data: { kind: 'session', sessionId: ro.appSessionId } });
    expect(() => broker.recordWorkspaceEvent(run.id, run.leadAgentId, 'workspace_archived', 'session')).toThrow(/lead project and session/);
    (store as unknown as { db: DatabaseSync }).db.prepare('UPDATE agents SET app_session_id = ? WHERE id = ?').run('lead-app', ro.id);
    expect(() => broker.recordWorkspaceEvent(run.id, ro.id, 'workspace_archived', 'session')).toThrow(/finished read-only worker/);
  });

  it('endRun removes a merged worker worktree whose post-merge cleanup failed', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    store.updateAgent(w.id, { status: 'merged' }); // merged, but removing the worktree failed: the path is still recorded
    await broker.endRun(run.id, true);
    expect(fs.existsSync(w.worktreePath!)).toBe(false);
    expect(store.agent(w.id)!.worktreePath).toBeNull();
  });

  it('endRun expires pending gates and cancels queued messages', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    await call('request_merge', { worker: w.id });
    const gate = store.gates(run.id).find((g) => g.kind === 'merge')!;
    expect(gate.status).toBe('pending');
    store.addMessage(run.id, null, w.id, 'message', 'never delivered');
    await broker.endRun(run.id, false);
    expect(store.gate(gate.id)!.status).toBe('expired');
    expect(store.events(run.id).some((e) => e.type === 'gate_decided' && e.data.gate === gate.id && e.data.status === 'expired')).toBe(true);
    expect(store.messages(run.id).filter((m) => m.state === 'queued')).toEqual([]);
    expect(broker.state(null, null).runs.find((r) => r.id === run.id)!.pendingGates).toBe(0);
  });
});

describe('wait_for_agents and batched results', () => {
  /** Spawns a worker whose first turn keeps running until released. */
  async function spawnHeld(role = 'planner') {
    cc.next.push('hold');
    const r = await broker.handleTool({ tool: 'spawn_agent', args: { role, task: 't' }, caller: LEAD });
    expect(r.ok, r.text).toBe(true);
    await Promise.resolve();
    return store.agent(r.text.match(/Spawned (\S+)/)![1])!;
  }
  const workerProv = (id: string) => cc.sessionByAppId(store.agent(id)!.appSessionId!)!.providerSessionId!;
  const wait = (args: Record<string, unknown> = {}) => broker.handleTool({ tool: 'wait_for_agents', args, caller: LEAD });

  it('stays pending while workers run and returns all results once in "all" mode', async () => {
    await startApprovedRun();
    const a = await spawnHeld();
    const b = await spawnHeld();
    expect(await wait()).toMatchObject({ pending: true });

    await broker.handleTool({ tool: 'report_result', args: { summary: 'A done', agent_id: a.id }, caller: workerCaller(workerProv(a.id)) });
    expect(await wait()).toMatchObject({ pending: true }); // a reported but its turn is still open; b still working

    cc.holds.splice(0).forEach((r) => r()); // both turns end
    await broker.handleTool({ tool: 'report_result', args: { summary: 'B done', agent_id: b.id }, caller: workerCaller(workerProv(b.id)) });
    await broker.settle();
    const done = await wait();
    expect(done.pending).toBeFalsy();
    expect(done.text).toMatch(/A done[\s\S]*B done/);
    expect(done.text).toMatch(/No targeted worker is still working/);
    expect(done.text).toContain(`Waited on: ${a.id}, ${b.id}.`); // the chat card reads its workers from here
    const starts = store.events(store.agent(a.id)!.runId).filter((e) => e.type === 'wait_start');
    expect(starts.at(-1)!.data.agents).toEqual([a.id, b.id]);
    // Consumed by the wait, so never pushed to the lead as a separate turn.
    expect(cc.calls.filter((c) => c.sessionId === 'lead-app' && /A done/.test(c.message))).toHaveLength(0);
  });

  it('"any" returns on the first result while others keep working', async () => {
    await startApprovedRun();
    const a = await spawnHeld();
    await spawnHeld();
    await broker.handleTool({ tool: 'report_result', args: { summary: 'first', agent_id: a.id }, caller: workerCaller(workerProv(a.id)) });
    const r = await wait({ mode: 'any' });
    expect(r.pending).toBeFalsy();
    expect(r.text).toMatch(/first[\s\S]*Still working: /);
    cc.holds.splice(0).forEach((x) => x());
    await broker.settle();
  });

  it('returns early when a worker asks the lead something', async () => {
    await startApprovedRun();
    const a = await spawnHeld();
    expect(await wait()).toMatchObject({ pending: true }); // the lead is blocked waiting (holds its inbox)
    await broker.handleTool({ tool: 'send_message', args: { to: 'lead', body: 'which DB?', agent_id: a.id }, caller: workerCaller(workerProv(a.id)) });
    await broker.tick();
    const r = await wait();
    expect(r.pending).toBeFalsy();
    expect(r.text).toMatch(/which DB\?/);
    cc.holds.splice(0).forEach((x) => x());
    await broker.settle();
  });

  it('without a wait, results are held until no worker is working, then delivered in one turn', async () => {
    await startApprovedRun();
    const a = await spawnHeld();
    await spawnHeld();
    await broker.handleTool({ tool: 'report_result', args: { summary: 'early', agent_id: a.id }, caller: workerCaller(workerProv(a.id)) });
    await broker.tick(); await Promise.resolve();
    expect(cc.calls.filter((c) => c.sessionId === 'lead-app' && /early/.test(c.message))).toHaveLength(0);

    cc.holds.splice(0).forEach((x) => x());
    await broker.settle();
    await broker.tick(); await broker.settle();
    expect(cc.calls.filter((c) => c.sessionId === 'lead-app' && /early/.test(c.message))).toHaveLength(1);
  });

  it('always ends with the authoritative "Waited on" list, even when a non-target sends an urgent message or a result', async () => {
    await startApprovedRun();
    const a = await spawnHeld();
    const b = await spawnHeld();
    const c = await spawnHeld();
    // Wait on a and b only; a reports (turn still open), c is not a target.
    expect(await wait({ agents: [a.id, b.id] })).toMatchObject({ pending: true });
    await broker.handleTool({ tool: 'report_result', args: { summary: 'A done', agent_id: a.id }, caller: workerCaller(workerProv(a.id)) });
    await broker.handleTool({ tool: 'send_message', args: { to: 'lead', body: 'urgent from C', agent_id: c.id }, caller: workerCaller(workerProv(c.id)) });
    const urgent = await wait({ agents: [a.id, b.id] });
    expect(urgent.pending).toBeFalsy();
    expect(urgent.text).toContain(`### From ${c.id} · message`);
    expect(urgent.text.endsWith(`\n\nWaited on: ${a.id}, ${b.id}.`)).toBe(true);

    // mode "any": a non-target's result is delivered too, the list still names only the targets.
    await broker.handleTool({ tool: 'report_result', args: { summary: 'C done', agent_id: c.id }, caller: workerCaller(workerProv(c.id)) });
    await broker.handleTool({ tool: 'report_result', args: { summary: 'B done', agent_id: b.id }, caller: workerCaller(workerProv(b.id)) });
    const any = await wait({ mode: 'any', agents: [b.id] });
    expect(any.pending).toBeFalsy();
    expect(any.text).toMatch(/C done[\s\S]*B done/);
    expect(any.text.endsWith(`\n\nWaited on: ${b.id}.`)).toBe(true);

    // Time limit.
    const timeout = await wait({ agents: [a.id], give_up: true });
    expect(timeout.text).toMatch(/^Stopped waiting after the time limit/);
    expect(timeout.text.endsWith(`\n\nWaited on: ${a.id}.`)).toBe(true);
    cc.holds.splice(0).forEach((x) => x());
    await broker.settle();
  });

  it('says "Waited on: none." when there is nothing to wait for', async () => {
    await startApprovedRun();
    const r = await wait();
    expect(r.text).toBe('There are no active workers to wait for.\n\nWaited on: none.');
  });

  it('records the wait in the timeline', async () => {
    const run = await startApprovedRun();
    const w = await spawnHeld();
    await wait();
    cc.holds.splice(0).forEach((x) => x());
    await broker.settle();
    await wait();
    const types = store.events(run.id).map((e) => e.type);
    expect(types.filter((t) => t === 'wait_start')).toHaveLength(1);
    expect(types.at(-1)).toBe('wait_end');
    expect(store.events(run.id).at(-1)!.data).toMatchObject({ reason: 'done', agents: [w.id], allFinished: true });
  });
});

describe('inline gates (elicitation path)', () => {
  it('gate_decide answers the blocked submit_plan call and nothing is pushed as a new turn', async () => {
    const opened = await broker.handleTool({ tool: 'submit_plan', args: { plan: 'p' }, caller: LEAD });
    expect(opened.gate).toMatchObject({ kind: 'plan', body: 'p' });
    expect(await broker.handleTool({ tool: 'gate_wait', args: { gate: opened.gate!.id }, caller: LEAD })).toMatchObject({ pending: true });

    const r = await broker.handleTool({ tool: 'gate_decide', args: { gate: opened.gate!.id, approve: true, comment: 'ok' }, caller: LEAD });
    expect(r.text).toMatch(/APPROVED your plan[\s\S]*ok/);
    await broker.settle(); await broker.tick(); await broker.settle();
    expect(cc.calls.filter((c) => c.sessionId === 'lead-app')).toHaveLength(0);
    expect(store.runs()[0].planStatus).toBe('approved');
  });

  it('a decision made in the tab is picked up by the waiting call', async () => {
    const opened = await broker.handleTool({ tool: 'submit_plan', args: { plan: 'p' }, caller: LEAD });
    await broker.handleTool({ tool: 'gate_wait', args: { gate: opened.gate!.id }, caller: LEAD }); // lease held
    await broker.decideGate(opened.gate!.id, false, 'no');
    await broker.settle();
    expect(cc.calls).toHaveLength(0); // leased: not pushed
    const r = await broker.handleTool({ tool: 'gate_wait', args: { gate: opened.gate!.id }, caller: LEAD });
    expect(r.pending).toBeFalsy();
    expect(r.text).toMatch(/REJECTED your plan[\s\S]*no/);
  });

  it('workers cannot decide gates', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    await call('request_merge', { worker: w.id });
    const g = store.gates(w.runId).find((x) => x.kind === 'merge')!;
    const r = await call('gate_decide', { gate: g.id, approve: true }, workerCaller(w.providerSessionId!));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Only the lead/);
  });
});

describe('worker capacity and end_agent', () => {
  it('finished read-only workers free their slot', async () => {
    await startApprovedRun();
    for (let i = 0; i < MAX_WORKERS; i++) {
      const w = await spawn('planner');
      await call('report_result', { summary: `plan ${i}` }, workerCaller(w.providerSessionId!));
    }
    const r = await call('spawn_agent', { role: 'planner', task: 'one more' });
    expect(r.ok, r.text).toBe(true);
  });

  it('end_agent frees the slot of an unmerged writer, keeps its worktree unless asked, and rejects its merge gate', async () => {
    await startApprovedRun();
    const ws = [];
    for (let i = 0; i < MAX_WORKERS; i++) ws.push(await spawn('coder'));
    expect((await call('spawn_agent', { role: 'coder', task: 't' })).ok).toBe(false);

    await call('request_merge', { worker: ws[0].id });
    const ended = await call('end_agent', { worker: ws[0].id });
    expect(ended.ok, ended.text).toBe(true);
    expect(store.agent(ws[0].id)!.status).toBe('ended');
    expect(fs.existsSync(ws[0].worktreePath!)).toBe(true);
    expect(store.gates(ws[0].runId).find((g) => g.kind === 'merge')!.status).toBe('rejected');
    expect((await call('spawn_agent', { role: 'coder', task: 't' })).ok).toBe(true);

    expect((await call('end_agent', { worker: ws[1].id, remove_worktree: true })).ok).toBe(true);
    expect(fs.existsSync(ws[1].worktreePath!)).toBe(false);
    expect(sh(repo, 'branch', '--list', ws[1].branch!)).toContain(ws[1].branch!);
    expect((await call('end_agent', { worker: ws[1].id })).text).toMatch(/already ended/);
    expect((await call('end_agent', { worker: ws[2].id }, workerCaller(ws[2].providerSessionId!))).text).toMatch(/Only the lead/);
  });

  it('the user can end a worker from the tab; the lead is told', async () => {
    await startApprovedRun();
    const w = await spawn('reviewer');
    await broker.endAgent(w.id, false, null);
    await broker.settle();
    expect(store.agent(w.id)!.status).toBe('ended');
    expect(cc.calls.at(-1)!.message).toMatch(new RegExp(`user ended ${w.id}`));
  });
});

describe('run-scoped ids', () => {
  it('ids, branches and worktrees do not collide across runs of the same repo', async () => {
    const run1 = await startApprovedRun();
    const a = await spawn('coder');
    await broker.endRun(run1.id, false);
    // A new lead session in the same project starts a second run.
    cc.sessions.set('lead2-prov', { appSessionId: 'lead2-app', providerSessionId: 'lead2-prov', provider: 'claude', projectPath: repo });
    const LEAD2: Caller = { provider: 'claude', providerSessionId: 'lead2-prov', cwd: null };
    await call('submit_plan', { plan: 'p2' }, LEAD2);
    const run2 = store.runs().find((r) => r.id !== run1.id)!;
    await broker.decideGate(store.gates(run2.id)[0].id, true, null);
    await broker.settle();
    const r = await call('spawn_agent', { role: 'coder', task: 't' }, LEAD2);
    const b = store.agent(r.text.match(/Spawned (\S+)/)![1])!;
    expect(run2.id).not.toBe(run1.id);
    expect(b.id).not.toBe(a.id);
    expect(b.branch).toBe(`coagent/${run2.id}/${b.id}`);
    expect(b.branch).not.toBe(a.branch);
    expect(b.worktreePath).not.toBe(a.worktreePath);
    expect(fs.existsSync(a.worktreePath!) && fs.existsSync(b.worktreePath!)).toBe(true);
  });

  it('a failed spawn leaves no agent, message, event, worktree or branch behind', async () => {
    const run = await startApprovedRun();
    const before = { msgs: store.messages(run.id).length, events: store.events(run.id).length };
    const orig = store.createAgent.bind(store);
    store.createAgent = () => { throw new Error('disk full'); };
    const r = await call('spawn_agent', { role: 'coder', task: 't' });
    store.createAgent = orig;
    expect(r.ok).toBe(false);
    expect(store.agents(run.id).map((x) => x.role)).toEqual(['lead']);
    expect(store.messages(run.id)).toHaveLength(before.msgs);
    expect(store.events(run.id)).toHaveLength(before.events);
    expect(fs.readdirSync(path.join(tmp, 'proj-worktrees'))).toEqual([]);
    expect(sh(repo, 'branch', '--list', 'coagent/*')).toBe('');
    expect(sh(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('a worktree that cannot be created fails the spawn cleanly', async () => {
    const run = await startApprovedRun();
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true }); // no longer a repo
    const r = await call('spawn_agent', { role: 'coder', task: 't' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Could not create a worktree/);
    expect(store.agents(run.id)).toHaveLength(1);
  });
});

describe('crash recovery', () => {
  const dbFile = () => path.join(tmp, 'db.sqlite');
  /** Simulates a broker crash: the old process's memory is gone; a fresh Store + Broker open the same DB. */
  function restart(advanceMs = 0) {
    store.close();
    clock += advanceMs;
    store = new Store(dbFile());
    cc = Object.assign(new FakeCloudCli(), { sessions: cc.sessions, live: cc.live }); // CloudCLI outlives the broker
    broker = new Broker({ store, cloudcli: cc, git: Git, prompts: filePrompts(PROMPTS), now: () => clock });
    return broker;
  }

  it('a message stuck in dispatching is re-queued after its lease and delivered exactly once', async () => {
    await call('submit_plan', { plan: 'p' });
    const run = store.runs()[0];
    cc.next.push('hold'); // the lead's turn carrying the approval never finishes: the broker dies mid-turn
    await broker.decideGate(store.gates(run.id)[0].id, true, null);
    await new Promise((r) => setTimeout(r, 0));
    const [m] = store.messages(run.id).filter((x) => x.to === run.leadAgentId);
    expect(m).toMatchObject({ state: 'dispatching', attempts: 1, deliveredAt: null });

    // Restart before the lease runs out: not touched yet (another process might still own it).
    await restart(1_000).recover();
    await broker.settle();
    expect(store.messages(run.id).find((x) => x.id === m.id)!.state).toBe('dispatching');
    expect(cc.calls).toHaveLength(0);

    clock += 2 * 120_000;
    await broker.tick(); await broker.settle();
    const after = store.messages(run.id).find((x) => x.id === m.id)!;
    expect(after).toMatchObject({ state: 'delivered', attempts: 2 });
    expect(after.deliveredAt).not.toBeNull();
    expect(cc.calls.filter((c) => /APPROVED your plan/.test(c.message))).toHaveLength(1);
    await broker.tick(); await broker.settle();
    expect(cc.calls).toHaveLength(1);
    expect(store.events(run.id).some((e) => e.type === 'recovered' && (e.data.requeued as number[]).includes(m.id))).toBe(true);
  });

  it('expired dispatches are re-queued at startup', async () => {
    await call('submit_plan', { plan: 'p' });
    const run = store.runs()[0];
    cc.next.push('hold');
    await broker.decideGate(store.gates(run.id)[0].id, false, 'no');
    await new Promise((r) => setTimeout(r, 0));
    const res = await restart(10 * 60_000).recover();
    expect(res.requeued).toHaveLength(1);
    await broker.settle();
    expect(cc.calls.filter((c) => /REJECTED your plan/.test(c.message))).toHaveLength(1);
    expect(store.undelivered(run.leadAgentId)).toHaveLength(0);
  });

  it('a worker stuck running becomes interrupted, its task is not re-sent, and the lead is told', async () => {
    const run = await startApprovedRun();
    cc.next.push('hold');
    const r = await broker.handleTool({ tool: 'spawn_agent', args: { role: 'coder', task: 'write x' }, caller: LEAD });
    const id = r.text.match(/Spawned (\S+)/)![1];
    await new Promise((x) => setTimeout(x, 0));
    expect(store.agent(id)!.status).toBe('running');

    cc.live.clear(); // its CloudCLI turn died too
    const res = await restart(10 * 60_000).recover();
    await broker.settle();
    expect(res.interrupted).toEqual([id]);
    expect(store.agent(id)!.status).toBe('interrupted');
    const toWorker = cc.calls.filter((c) => c.projectPath === store.agent(id)!.cwd);
    expect(toWorker).toHaveLength(0); // never re-sent automatically
    const note = cc.calls.find((c) => c.sessionId === 'lead-app')!;
    expect(note.message).toContain(id);
    expect(note.message).toMatch(/NOT re-sent/);
    expect(note.message).toMatch(/end_agent/);
    expect(store.events(run.id).some((e) => e.type === 'recovered' && e.agentId === id && e.data.status === 'interrupted')).toBe(true);

    // Nothing is pushed while interrupted; the lead's message resumes it in the same session.
    await broker.tick(); await broker.settle();
    expect(cc.calls.filter((c) => c.projectPath === store.agent(id)!.cwd)).toHaveLength(0);
    const sent = await call('send_message', { to: id, body: 'you were interrupted; continue' });
    expect(sent.ok, sent.text).toBe(true);
    const resumed = cc.calls.filter((c) => c.projectPath === store.agent(id)!.cwd);
    expect(resumed).toHaveLength(1);
    expect(resumed[0].sessionId).toBe(store.agent(id)!.appSessionId);
    expect(resumed[0].message).toMatch(/continue/);
    expect(resumed[0].message).not.toMatch(/write x/);
    expect(store.agent(id)!.status).toBe('idle');
  });

  it('an interrupted worker can be ended to free its slot', async () => {
    await startApprovedRun();
    cc.next.push('hold');
    const r = await broker.handleTool({ tool: 'spawn_agent', args: { role: 'planner', task: 't' }, caller: LEAD });
    const id = r.text.match(/Spawned (\S+)/)![1];
    await new Promise((x) => setTimeout(x, 0));
    cc.live.clear(); // its CloudCLI turn died too
    await restart(10 * 60_000).recover();
    await broker.settle();
    expect((await call('end_agent', { worker: id })).ok).toBe(true);
    expect(store.agent(id)!.status).toBe('ended');
  });

  it('a spawned worker whose first turn was never dispatched is simply started after a restart', async () => {
    const run = await startApprovedRun();
    // Persisted but not dispatched (crash right after the spawn transaction).
    store.createAgent({ id: 'coder-aaaaaa', runId: run.id, role: 'planner', provider: 'claude', cwd: repo, status: 'starting', task: 'plan it' });
    store.addMessage(run.id, run.leadAgentId, 'coder-aaaaaa', 'message', 'plan it');
    const res = await restart().recover();
    await broker.settle();
    expect(res.interrupted).toEqual([]);
    const first = cc.calls.find((c) => c.message.includes('agent id: coder-aaaaaa'))!;
    expect(first.message).toContain('plan it');
    expect(store.agent('coder-aaaaaa')!.status).toBe('idle');
  });

  it('migrates a database that only has delivered_at', () => {
    store.close();
    const file = path.join(tmp, 'old.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, lead_agent_id TEXT NOT NULL, project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', plan_status TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL, ended_at TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, from_agent TEXT, to_agent TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT);
    CREATE INDEX messages_inbox ON messages(to_agent, delivered_at);
    INSERT INTO runs (id, lead_agent_id, project_path, created_at) VALUES ('r-1', 'lead-1', '/p', 't');
    INSERT INTO messages (run_id, to_agent, kind, body, created_at, delivered_at) VALUES ('r-1', 'lead-1', 'message', 'old', 't', 't2');
    INSERT INTO messages (run_id, to_agent, kind, body, created_at) VALUES ('r-1', 'lead-1', 'message', 'pending', 't');`);
    db.close();
    for (let i = 0; i < 2; i++) { // idempotent
      store = new Store(file);
      const ms = store.messages('r-1');
      expect(ms.map((m) => [m.body, m.state, m.deliveredAt])).toEqual([['old', 'delivered', 't2'], ['pending', 'queued', null]]);
      expect(store.undelivered('lead-1').map((m) => m.body)).toEqual(['pending']);
      store.close();
    }
    store = new Store(dbFile());
  });
});

describe('review fixes (rework)', () => {
  const dbFile = () => path.join(tmp, 'db.sqlite');
  function restart(advanceMs = 0) {
    store.close();
    clock += advanceMs;
    store = new Store(dbFile());
    cc = Object.assign(new FakeCloudCli(), { sessions: cc.sessions, live: cc.live });
    broker = new Broker({ store, cloudcli: cc, git: Git, prompts: filePrompts(PROMPTS), now: () => clock });
    return broker;
  }
  async function spawnHeld(role: string, task = 't') {
    cc.next.push('hold');
    const r = await broker.handleTool({ tool: 'spawn_agent', args: { role, task }, caller: LEAD });
    expect(r.ok, r.text).toBe(true);
    await new Promise((x) => setTimeout(x, 0));
    return store.agent(r.text.match(/Spawned (\S+)/)![1])!;
  }
  const provOf = (id: string) => cc.sessionByAppId(store.agent(id)!.appSessionId!)!.providerSessionId!;
  const toWorker = (id: string) => cc.calls.filter((c) => c.projectPath === store.agent(id)!.cwd && c.sessionId !== 'lead-app');

  // 1
  it('report_result acknowledges the dispatch: a crash before the stream closes never re-runs the task', async () => {
    await startApprovedRun();
    const w = await spawnHeld('coder', 'write x');
    const task = store.messages(w.runId).find((m) => m.to === w.id)!;
    expect(task.state).toBe('dispatching');
    await broker.handleTool({ tool: 'report_result', args: { summary: 'done', agent_id: w.id }, caller: workerCaller(provOf(w.id)) });
    expect(store.messages(w.runId).find((m) => m.id === task.id)!.state).toBe('delivered');

    cc.live.clear();
    const res = await restart(10 * 60_000).recover();
    await broker.tick(); await broker.settle();
    clock += 10 * 60_000;
    await broker.tick(); await broker.settle();
    expect(res.interrupted).toEqual([]);
    expect(toWorker(w.id)).toHaveLength(0);
    expect(store.agent(w.id)!.status).toBe('reported');
  });

  it('a worker orphan dispatch is closed, never re-queued, even if its status is not running', async () => {
    await startApprovedRun();
    const w = await spawnHeld('planner');
    // Simulate a status change that did not acknowledge the dispatch (older code path).
    store.updateAgent(w.id, { status: 'reported' });
    cc.live.clear();
    await restart(10 * 60_000).recover();
    clock += 10 * 60_000;
    await broker.tick(); await broker.settle();
    expect(toWorker(w.id)).toHaveLength(0);
    expect(store.dispatching(w.id)).toHaveLength(0);
    expect(store.undelivered(w.id)).toHaveLength(0);
  });

  // 2
  it('a worker still processing in CloudCLI stays running (detached), is followed, and its report still counts', async () => {
    await startApprovedRun();
    const w = await spawnHeld('coder');
    const res = await restart(10 * 60_000).recover(); // live: CloudCLI is still running its turn
    await broker.settle();
    expect(res).toMatchObject({ interrupted: [], detached: [w.id] });
    const a = store.agent(w.id)!;
    expect(a).toMatchObject({ status: 'running', busy: false });
    expect(cc.calls.find((c) => c.sessionId === 'lead-app')!.message).toMatch(/Still running in CloudCLI/);
    expect((await call('wait_for_agents', {})).pending).toBe(true); // still counts as working
    const merge = await call('request_merge', { worker: w.id });
    expect(merge.ok).toBe(false);
    expect(merge.text).toMatch(/still running/); // detached turns count as in-flight even though store.busy is false
    // A rework message is held while the detached turn runs.
    await call('send_message', { to: w.id, body: 'also do y' });
    expect(toWorker(w.id)).toHaveLength(0);
    // remove_worktree is refused while it is processing.
    const refused = await call('end_agent', { worker: w.id, remove_worktree: true });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/still running a turn/);
    expect(fs.existsSync(w.worktreePath!)).toBe(true);

    await broker.handleTool({ tool: 'report_result', args: { summary: 'late result', agent_id: w.id }, caller: workerCaller(provOf(w.id)) });
    cc.live.clear();
    clock += 31_000;
    await broker.tick(); await broker.settle();
    expect(store.agent(w.id)!.status).not.toBe('interrupted');
    expect(toWorker(w.id).map((c) => c.message).join()).toMatch(/also do y/); // delivered once the session is free
  });

  it('a detached turn that ends without reporting moves to idle and the lead is told', async () => {
    await startApprovedRun();
    const w = await spawnHeld('planner');
    await restart(10 * 60_000).recover();
    await broker.settle();
    await broker.tick(); await broker.settle();
    expect(store.agent(w.id)!.status).toBe('running'); // not re-checked before DETACHED_CHECK_MS
    cc.live.clear();
    clock += 31_000;
    await broker.tick(); await broker.settle();
    expect(store.agent(w.id)!.status).toBe('idle');
    expect(cc.calls.at(-1)!.message).toMatch(/finished without report_result/);
  });

  it('unknown session state → interrupted, and its worktree cannot be deleted', async () => {
    await startApprovedRun();
    const w = await spawnHeld('coder');
    restart(10 * 60_000);
    cc.status = () => null; // host without the session-status endpoint
    const res = await broker.recover();
    await broker.settle();
    expect(res.interrupted).toEqual([w.id]);
    expect(cc.calls.find((c) => c.sessionId === 'lead-app')!.message).toMatch(/session state unknown/);
    const r = await call('end_agent', { worker: w.id, remove_worktree: true });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/cannot confirm/);
    expect(store.agent(w.id)!.status).toBe('interrupted');
    expect((await call('end_agent', { worker: w.id })).ok).toBe(true);
    expect(fs.existsSync(w.worktreePath!)).toBe(true);
  });

  it('end_agent remove_worktree refuses when CloudCLI says the session is processing', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    cc.status = () => true; // e.g. the user is typing in its session
    expect((await call('end_agent', { worker: w.id, remove_worktree: true })).ok).toBe(false);
    expect(store.agent(w.id)!.status).toBe('idle');
    cc.status = () => false;
    expect((await call('end_agent', { worker: w.id, remove_worktree: true })).ok).toBe(true);
    expect(fs.existsSync(w.worktreePath!)).toBe(false);
  });

  // 3
  it('an error after CloudCLI accepted the turn closes the dispatch: no automatic retry', async () => {
    await startApprovedRun();
    cc.next.push('accepted-error');
    const r = await call('spawn_agent', { role: 'planner', task: 'once only' });
    const id = r.text.match(/Spawned (\S+)/)![1];
    expect(store.agent(id)).toMatchObject({ status: 'error', lastError: 'died mid-turn' });
    expect(store.messages(store.agent(id)!.runId).find((m) => m.to === id)!.state).toBe('delivered');
    expect(cc.calls.at(-1)!.message).toMatch(/failed: died mid-turn/);
    clock += 10 * 60_000;
    await broker.tick(); await broker.settle();
    expect(toWorker(id).filter((c) => /once only/.test(c.message))).toHaveLength(1);
  });

  it('an error before acceptance still re-queues and retries', async () => {
    await startApprovedRun();
    cc.next.push('error');
    const r = await call('spawn_agent', { role: 'planner', task: 'retry me' });
    const id = r.text.match(/Spawned (\S+)/)![1];
    expect(store.undelivered(id)).toHaveLength(1);
    clock += 10_000;
    await broker.tick(); await broker.settle();
    expect(toWorker(id).filter((c) => /retry me/.test(c.message))).toHaveLength(2);
  });

  // 4
  it('end_agent is a stop barrier: nothing can start a turn while its worktree is being removed', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    await call('send_message', { to: w.id, body: 'queued rework' }); // delivered at once (idle)
    let release!: () => void;
    const removing = new Promise<void>((r) => { release = r; });
    broker = new Broker({
      store, cloudcli: cc, prompts: filePrompts(PROMPTS), now: () => clock,
      git: { ...Git, removeOwnedWorktree: async (...args: Parameters<typeof Git.removeOwnedWorktree>) => { await removing; return Git.removeOwnedWorktree(...args); } },
    });
    cc.status = () => false;
    store.addMessage(w.runId, null, w.id, 'message', 'late user message');
    const ending = broker.endAgent(w.id, true, store.runs()[0].leadAgentId);
    for (let i = 0; i < 200 && store.agent(w.id)!.status !== 'ended'; i++) await new Promise((x) => setTimeout(x, 5));
    expect(store.agent(w.id)!.status).toBe('ended'); // persisted before the cleanup await
    const before = toWorker(w.id).length;
    await broker.tick();
    expect(() => broker.userMessage(w.id, 'x')).toThrow(/ended/);
    expect((await broker.handleTool({ tool: 'send_message', args: { to: w.id, body: 'y' }, caller: LEAD })).ok).toBe(false);
    release();
    expect(await ending).toMatch(/1 undelivered message\(s\) to it were cancelled[\s\S]*Deleted its worktree/);
    await broker.settle();
    expect(toWorker(w.id)).toHaveLength(before);
    expect(store.messages(w.runId).find((m) => m.body === 'late user message')!.state).toBe('cancelled');
  });

  it('a failed worktree cleanup is reported but the agent stays ended', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    broker = new Broker({
      store, cloudcli: cc, prompts: filePrompts(PROMPTS), now: () => clock,
      git: { ...Git, removeOwnedWorktree: async () => { throw new Error('permission denied'); } },
    });
    const text = await broker.endAgent(w.id, true, null);
    expect(text).toMatch(/deleting its worktree .* failed: permission denied/);
    expect(store.agent(w.id)).toMatchObject({ status: 'ended', worktreePath: w.worktreePath });
  });

  // 5
  it('rework for a slot-less worker waits for a free slot; interrupted and pending workers hold one', async () => {
    await startApprovedRun();
    const rv = await spawn('reviewer');
    await call('report_result', { summary: 'lgtm' }, workerCaller(rv.providerSessionId!));
    const coders = [];
    for (let i = 0; i < MAX_WORKERS; i++) coders.push(await spawn('coder'));
    const before = toWorker(rv.id).length;
    const r = await call('send_message', { to: rv.id, body: 'review again' });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/worker slots are in use[\s\S]*stays queued/);
    expect(toWorker(rv.id)).toHaveLength(before);
    expect((await call('spawn_agent', { role: 'planner', task: 't' })).text).toMatch(/Worker limit/);

    await call('end_agent', { worker: coders[0].id });
    await broker.tick(); await broker.settle();
    expect(toWorker(rv.id).map((c) => c.message).join()).toMatch(/review again/);
  });

  it('an interrupted read-only worker holds its slot', async () => {
    await startApprovedRun();
    const p = await spawnHeld('planner');
    cc.live.clear();
    await restart(10 * 60_000).recover();
    await broker.settle();
    expect(store.agent(p.id)!.status).toBe('interrupted');
    for (let i = 0; i < MAX_WORKERS - 1; i++) await spawn('coder');
    expect((await call('spawn_agent', { role: 'coder', task: 't' })).text).toMatch(/Worker limit/);
  });

  // 6
  it('an ended worker cannot read its inbox or report, and its queued messages are cancelled', async () => {
    await startApprovedRun();
    const w = await spawn('planner');
    const caller = workerCaller(w.providerSessionId!);
    store.addMessage(w.runId, null, w.id, 'message', 'never delivered'); // queued, not yet ticked
    await call('end_agent', { worker: w.id });
    expect(store.agentsWithUndelivered()).not.toContain(w.id);
    expect(store.messages(w.runId).find((m) => m.body === 'never delivered')!.state).toBe('cancelled');
    const inbox = await call('read_inbox', {}, caller);
    expect(inbox.ok).toBe(false);
    expect(inbox.text).toMatch(/no longer take part/);
    expect((await call('report_result', { summary: 'sneaky' }, caller)).ok).toBe(false);
    expect((await call('send_message', { to: 'lead', body: 'hi' }, caller)).ok).toBe(false);
    expect(store.agent(w.id)!.status).toBe('ended');
  });
});

describe('endRun safety (review: stop barrier, repo lock, stale paths)', () => {
  /** Rebuilds the broker on the same store with some git operations replaced. */
  const withGit = (over: Partial<typeof Git>) => {
    broker = new Broker({ store, cloudcli: cc, prompts: filePrompts(PROMPTS), now: () => clock, git: { ...Git, ...over } });
  };
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  };

  it('a failed removal keeps the path and reports it', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    withGit({ removeOwnedWorktree: async () => { throw new Error('permission denied'); } });
    const res = await broker.endRun(run.id, true);
    expect(res.failedWorktrees).toEqual([{ agentId: w.id, path: w.worktreePath, reason: 'permission denied' }]);
    expect(store.agent(w.id)!.worktreePath).toBe(w.worktreePath);
    expect(store.run(run.id)!.status).toBe('ended');
    expect(store.events(run.id).find((e) => e.type === 'run_ended')!.data.failedWorktrees).toEqual(res.failedWorktrees);
  });

  it('keeps the worktree of a worker whose turn is still in flight, and starts no new turn', async () => {
    const run = await startApprovedRun();
    cc.next.push('hold');
    const r = await broker.handleTool({ tool: 'spawn_agent', args: { role: 'coder', task: 't' }, caller: LEAD });
    const w = store.agent(r.text.match(/Spawned (\S+)/)![1])!;
    await Promise.resolve();
    store.addMessage(run.id, null, w.id, 'message', 'more work');
    cc.status = () => false; // even if CloudCLI claims idle, this process knows its own turn is still running
    const res = await broker.endRun(run.id, true);
    expect(res.failedWorktrees).toEqual([{ agentId: w.id, path: w.worktreePath, reason: 'still running' }]);
    expect(fs.existsSync(w.worktreePath!)).toBe(true);
    const sends = cc.calls.length;
    cc.holds.forEach((release) => release());
    await broker.settle();
    await broker.tick();
    await broker.settle();
    expect(cc.calls.length).toBe(sends);
    expect(store.messages(run.id).filter((m) => m.state === 'queued')).toEqual([]);
    // Once the turn is over, ending again retries the cleanup.
    cc.status = null;
    expect((await broker.endRun(run.id, true)).failedWorktrees).toEqual([]);
    expect(fs.existsSync(w.worktreePath!)).toBe(false);
  });

  it('keeps the worktree when CloudCLI cannot confirm the session is idle', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    cc.status = () => null;
    const res = await broker.endRun(run.id, true);
    expect(res.failedWorktrees).toMatchObject([{ agentId: w.id, reason: expect.stringMatching(/session state unknown/) }]);
    expect(fs.existsSync(w.worktreePath!)).toBe(true);
  });

  it('nothing is delivered while endRun waits for the repository lock', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    const sends = cc.calls.length;
    const hold = deferred();
    const entered = deferred();
    // A request_merge holding the repository lock (blocked in commitAll) keeps endRun waiting.
    withGit({ commitAll: async (...args: Parameters<typeof Git.commitAll>) => { entered.resolve(); await hold.promise; return Git.commitAll(...args); } });
    const merging = broker.handleTool({ tool: 'request_merge', args: { worker: w.id }, caller: LEAD });
    await entered.promise;
    const ending = broker.endRun(run.id, false);
    store.addMessage(run.id, null, w.id, 'message', 'rework');
    await broker.tick();
    await Promise.resolve();
    expect(cc.calls.length).toBe(sends);
    hold.resolve();
    await merging;
    await ending;
    await broker.settle();
    expect(cc.calls.length).toBe(sends);
    expect(store.messages(run.id).find((m) => m.body === 'rework')!.state).toBe('cancelled');
  });

  it('endRun waits for an in-progress merge; the merge decision stands and nothing is queued in the ended run', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'hello.txt'), 'hi');
    sh(w.worktreePath!, 'add', '.');
    sh(w.worktreePath!, 'commit', '-qm', 'hello');
    await call('request_merge', { worker: w.id });
    const gate = store.gates(run.id).find((g) => g.kind === 'merge')!;
    const hold = deferred();
    const entered = deferred();
    withGit({ merge: async (...args: Parameters<typeof Git.merge>) => { entered.resolve(); await hold.promise; return Git.merge(...args); } });
    const deciding = broker.decideGate(gate.id, true, null);
    await entered.promise;
    const ending = broker.endRun(run.id, true);
    await Promise.resolve();
    expect(store.run(run.id)!.status).toBe('active'); // endRun is waiting for the lock
    hold.resolve();
    await deciding;
    await ending;
    await broker.settle();
    expect(store.gate(gate.id)!.status).toBe('approved');
    expect(store.agent(w.id)!.status).toBe('merged');
    expect(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hi');
    expect(store.run(run.id)!.status).toBe('ended');
    expect(store.messages(run.id).filter((m) => m.state === 'queued' || m.state === 'dispatching')).toEqual([]);
  });

  it('an approval queued behind endRun finds the gate expired and does not merge', async () => {
    const run = await startApprovedRun();
    const a = await spawn('coder');
    const b = await spawn('coder');
    fs.writeFileSync(path.join(a.worktreePath!, 'a.txt'), 'a');
    sh(a.worktreePath!, 'add', '.');
    sh(a.worktreePath!, 'commit', '-qm', 'a');
    await call('request_merge', { worker: a.id });
    const gate = store.gates(run.id).find((g) => g.kind === 'merge')!;
    const head = sh(repo, 'rev-parse', 'HEAD');
    const hold = deferred();
    const entered = deferred();
    // A fixed lock key keeps the lock queue in call order (the real lookup runs git, whose timing varies).
    const key = await Git.commonDir(repo);
    withGit({
      commonDir: async () => key,
      commitAll: async (...args: Parameters<typeof Git.commitAll>) => { entered.resolve(); await hold.promise; return Git.commitAll(...args); },
    });
    const merging = broker.handleTool({ tool: 'request_merge', args: { worker: b.id }, caller: LEAD }); // holds the lock
    await entered.promise;
    const ending = broker.endRun(run.id, false); // persists 'ending' at once, then waits for the lock
    const deciding = broker.decideGate(gate.id, true, null);
    await expect(deciding).rejects.toThrow(/run has ended/); // refused before it can queue for the lock
    hold.resolve();
    await Promise.all([merging, ending]);
    await broker.settle();
    expect(store.gate(gate.id)!.status).toBe('expired');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(store.events(run.id).some((e) => e.type === 'merge')).toBe(false);
    expect(store.messages(run.id).filter((m) => m.state === 'queued')).toEqual([]);
  });

  it('gate decisions never overwrite a decided gate', async () => {
    const run = await startApprovedRun();
    const gate = store.gates(run.id)[0];
    expect(store.decideGate(gate.id, 'expired', 'x')).toBe(false);
    expect(store.gate(gate.id)!.status).toBe('approved');
  });

  it('does not remove a stale path that now belongs to another repository', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    sh(repo, 'worktree', 'remove', w.worktreePath!);
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    sh(other, 'init', '-q', '-b', 'main');
    sh(other, 'commit', '-q', '--allow-empty', '-m', 'init');
    sh(other, 'worktree', 'add', '-q', '-b', w.branch!, w.worktreePath!);
    const res = await broker.endRun(run.id, true);
    expect(res.failedWorktrees).toMatchObject([{ agentId: w.id, reason: expect.stringMatching(/is not a worktree of/) }]);
    expect(fs.existsSync(w.worktreePath!)).toBe(true);
    expect(sh(other, 'worktree', 'list')).toContain(w.worktreePath!);
    expect(store.agent(w.id)!.worktreePath).toBe(w.worktreePath);
  });

  it('does not remove a worktree of the lead repository that is on another branch', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    sh(repo, 'worktree', 'remove', w.worktreePath!);
    sh(repo, 'worktree', 'add', '-q', '-b', 'someone-else', w.worktreePath!);
    const res = await broker.endRun(run.id, true);
    expect(res.failedWorktrees).toMatchObject([{ agentId: w.id, reason: expect.stringMatching(/checked out on someone-else/) }]);
    expect(fs.existsSync(w.worktreePath!)).toBe(true);
  });

  it('a worktree that is already gone counts as removed', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    fs.rmSync(w.worktreePath!, { recursive: true, force: true });
    expect((await broker.endRun(run.id, true)).failedWorktrees).toEqual([]);
    expect(store.agent(w.id)!.worktreePath).toBeNull();
    expect(sh(repo, 'worktree', 'list')).not.toContain(w.worktreePath!);
  });

  it('a lead blocked in gate_wait gets the expiry; one in wait_for_agents stops with reason run_ended', async () => {
    const r = await call('submit_plan', { plan: 'p' });
    expect(r.ok).toBe(true);
    const run = store.runs()[0];
    const gate = store.gates(run.id)[0];
    expect((await call('gate_wait', { gate: gate.id })).pending).toBe(true);
    await broker.endRun(run.id, false);
    const answer = await call('gate_wait', { gate: gate.id });
    expect(answer).toMatchObject({ ok: true });
    expect(answer.pending).toBeFalsy();
    expect(answer.text).toMatch(/Gate #\d+ EXPIRED: the user ended run .* Nothing was approved/);

    // wait_for_agents on a second run
    cc.sessions.set('lead2-prov', { appSessionId: 'lead2-app', providerSessionId: 'lead2-prov', provider: 'claude', projectPath: repo });
    const LEAD2: Caller = { provider: 'claude', providerSessionId: 'lead2-prov', cwd: null };
    await call('submit_plan', { plan: 'p2' }, LEAD2);
    const run2 = store.runs().find((x) => x.id !== run.id)!;
    await broker.decideGate(store.gates(run2.id)[0].id, true, null);
    await broker.settle();
    cc.next.push('hold');
    await broker.handleTool({ tool: 'spawn_agent', args: { role: 'planner', task: 't' }, caller: LEAD2 });
    await Promise.resolve();
    expect((await broker.handleTool({ tool: 'wait_for_agents', args: {}, caller: LEAD2 })).pending).toBe(true);
    await broker.endRun(run2.id, false);
    const ends = store.events(run2.id).filter((e) => e.type === 'wait_end');
    expect(ends.map((e) => e.data.reason)).toEqual(['run_ended']);
    const after = await broker.handleTool({ tool: 'wait_for_agents', args: {}, caller: LEAD2 });
    expect(after).toMatchObject({ ok: true });
    expect(after.text).toMatch(/ended run/);
    await broker.tick();
    expect(store.events(run2.id).filter((e) => e.type === 'wait_end')).toHaveLength(1); // never "abandoned" later
    cc.holds.forEach((release) => release());
    await broker.settle();
  });

  it('a spawn that finishes creating its worktree after the run ended is rolled back', async () => {
    const run = await startApprovedRun();
    const hold = deferred();
    const entered = deferred();
    let created = '';
    withGit({
      createWorktree: async (...args: Parameters<typeof Git.createWorktree>) => {
        entered.resolve(); await hold.promise;
        const res = await Git.createWorktree(...args); created = res.worktreePath; return res;
      },
    });
    const spawning = broker.handleTool({ tool: 'spawn_agent', args: { role: 'coder', task: 't' }, caller: LEAD });
    await entered.promise;
    await broker.endRun(run.id, true);
    hold.resolve();
    const r = await spawning;
    expect(r).toMatchObject({ ok: false, text: expect.stringMatching(/run has ended/) });
    expect(fs.existsSync(created)).toBe(false);
    expect(store.agents(run.id).filter((a) => a.role !== 'lead')).toEqual([]);
  });
});

describe('end_agent / endRun re-review (lock scope, persisted stop)', () => {
  const withGit = (over: Partial<typeof Git>) => {
    broker = new Broker({ store, cloudcli: cc, prompts: filePrompts(PROMPTS), now: () => clock, git: { ...Git, ...over } });
  };
  const deferred = <T = void>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const commit = (w: { worktreePath: string | null }, file: string) => {
    fs.writeFileSync(path.join(w.worktreePath!, file), file);
    sh(w.worktreePath!, 'add', '.');
    sh(w.worktreePath!, 'commit', '-qm', file);
  };

  it('end_agent waits for a request_merge that is snapshotting the worktree, then rejects the new gate', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    commit(w, 'a.txt');
    const hold = deferred();
    const entered = deferred();
    withGit({ mergeSnapshot: async (...args: Parameters<typeof Git.mergeSnapshot>) => { entered.resolve(); await hold.promise; return Git.mergeSnapshot(...args); } });
    const merging = broker.handleTool({ tool: 'request_merge', args: { worker: w.id }, caller: LEAD });
    await entered.promise;
    const ending = broker.endAgent(w.id, true, null);
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(w.worktreePath!)).toBe(true); // not removed under the snapshot
    expect(store.agent(w.id)!.status).not.toBe('ended');
    hold.resolve();
    expect((await merging).ok).toBe(true);
    expect(await ending).toMatch(/Deleted its worktree/);
    const gate = store.gates(run.id).find((g) => g.kind === 'merge')!;
    expect(gate.status).toBe('rejected');
    expect(fs.existsSync(w.worktreePath!)).toBe(false);
  });

  it('end_agent arriving during a merge approval waits, then finds the worker merged', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    commit(w, 'b.txt');
    await call('request_merge', { worker: w.id });
    const gate = store.gates(run.id).find((g) => g.kind === 'merge')!;
    const hold = deferred();
    const entered = deferred();
    withGit({ merge: async (...args: Parameters<typeof Git.merge>) => { entered.resolve(); await hold.promise; return Git.merge(...args); } });
    const deciding = broker.decideGate(gate.id, true, null);
    await entered.promise;
    const ending = broker.endAgent(w.id, true, null);
    hold.resolve();
    await deciding;
    await expect(ending).rejects.toThrow(/already merged/);
    expect(store.gate(gate.id)!.status).toBe('approved');
    expect(store.agent(w.id)!.status).toBe('merged');
    expect(store.events(run.id).filter((e) => e.type === 'gate_decided' && e.data.gate === gate.id).map((e) => e.data.status)).toEqual(['approved']);
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('b.txt');
  });

  it('a merge approval that loses the race to end_agent is refused and merges nothing', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    commit(w, 'c.txt');
    await call('request_merge', { worker: w.id });
    const gate = store.gates(run.id).find((g) => g.kind === 'merge')!;
    const head = sh(repo, 'rev-parse', 'HEAD');
    await broker.endAgent(w.id, false, null);
    await expect(broker.decideGate(gate.id, true, null)).rejects.toThrow(/already rejected/);
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(store.events(run.id).some((e) => e.type === 'merge')).toBe(false);
  });

  it('endRun asks CloudCLI outside the repository lock: a merge in another run proceeds meanwhile', async () => {
    const run1 = await startApprovedRun();
    const a = await spawn('coder');
    // A second run on the same repository with a merge waiting for approval.
    cc.sessions.set('lead2-prov', { appSessionId: 'lead2-app', providerSessionId: 'lead2-prov', provider: 'claude', projectPath: repo });
    const LEAD2: Caller = { provider: 'claude', providerSessionId: 'lead2-prov', cwd: null };
    await call('submit_plan', { plan: 'p2' }, LEAD2);
    const run2 = store.runs().find((r) => r.id !== run1.id)!;
    await broker.decideGate(store.gates(run2.id)[0].id, true, null);
    await broker.settle();
    const b = store.agent((await call('spawn_agent', { role: 'coder', task: 't' }, LEAD2)).text.match(/Spawned (\S+)/)![1])!;
    commit(b, 'd.txt');
    await call('request_merge', { worker: b.id }, LEAD2);
    const gate = store.gates(run2.id).find((g) => g.kind === 'merge')!;

    const status = deferred<{ processing: boolean | null }>();
    const asked = deferred();
    cc.sessionStatus = async () => { asked.resolve(); return status.promise; };
    const ending = broker.endRun(run1.id, true);
    await asked.promise; // endRun is waiting on CloudCLI
    await broker.decideGate(gate.id, true, null); // would deadlock-wait if endRun held the lock
    expect(store.agent(b.id)!.status).toBe('merged');
    status.resolve({ processing: false });
    expect((await ending).failedWorktrees).toEqual([]);
    expect(fs.existsSync(a.worktreePath!)).toBe(false);
  });

  it('a session-status request that hangs times out as unknown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-status-'));
    const prev = process.env.COAGENT_API_KEY;
    process.env.COAGENT_API_KEY = 'ck_test';
    try {
      const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      })) as unknown as typeof fetch;
      const http = new HttpCloudCli({ pluginsConfigPath: path.join(dir, 'none.json'), localServerPath: path.join(dir, 'none.json'), fetchImpl: hang, statusTimeoutMs: 30 });
      const started = Date.now();
      expect(await http.sessionStatus('s-1')).toEqual({ processing: null });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      if (prev === undefined) delete process.env.COAGENT_API_KEY; else process.env.COAGENT_API_KEY = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a restart between marking the run ending and the stop: nothing starts, and recovery completes the stop', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    commit(w, 'e.txt');
    await call('request_merge', { worker: w.id });
    const gate = store.gates(run.id).find((g) => g.kind === 'merge')!;
    store.markEnding(run.id); // what endRun persists first; the process dies before stopRun
    store.addMessage(run.id, null, w.id, 'message', 'queued before the crash');

    // A fresh process on the same database.
    broker = new Broker({ store, cloudcli: cc, git: Git, prompts: filePrompts(PROMPTS), now: () => clock });
    expect(store.run(run.id)).toMatchObject({ status: 'active', ending: true });
    const sends = cc.calls.length;
    await broker.tick();
    await broker.settle();
    expect(cc.calls.length).toBe(sends); // delivery refuses an ending run
    expect((await call('spawn_agent', { role: 'planner', task: 't' })).text).toMatch(/run has ended/);
    await expect(broker.decideGate(gate.id, true, null)).rejects.toThrow(/run has ended/);

    await broker.recover();
    expect(store.run(run.id)!.status).toBe('ended');
    expect(store.gate(gate.id)!.status).toBe('expired');
    expect(store.messages(run.id).find((m) => m.body === 'queued before the crash')!.state).toBe('cancelled');
    expect(store.events(run.id).filter((e) => e.type === 'run_ended').map((e) => e.data)).toEqual([{ recovered: true }]);
    expect(fs.existsSync(w.worktreePath!)).toBe(true); // cleanup is not automatic; endRun again retries it
    expect((await broker.endRun(run.id, true)).failedWorktrees).toEqual([]);
    expect(fs.existsSync(w.worktreePath!)).toBe(false);
    await broker.recover(); // idempotent: no second run_ended
    expect(store.events(run.id).filter((e) => e.type === 'run_ended')).toHaveLength(1);
  });

  it('recovery records a missing run_ended for a run that stopped but crashed during cleanup', async () => {
    const run = await startApprovedRun();
    store.markEnding(run.id);
    store.endRun(run.id); // stopped, but the process died before recording run_ended
    broker = new Broker({ store, cloudcli: cc, git: Git, prompts: filePrompts(PROMPTS), now: () => clock });
    await broker.recover();
    expect(store.events(run.id).filter((e) => e.type === 'run_ended').map((e) => e.data)).toEqual([{ recovered: true }]);
  });

  it('migrates an older database without runs.ending_at', () => {
    const file = path.join(tmp, 'old-runs.sqlite');
    new Store(file).close();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE runs DROP COLUMN ending_at');
    expect(pendingMigrations(raw)).toEqual(['column runs.ending_at']);
    raw.close();
    new Store(file).close();
    const again = new DatabaseSync(file, { readOnly: true });
    expect(pendingMigrations(again)).toEqual([]);
    again.close();
  });
});

describe('merge gate outcome (third review)', () => {
  /** A worker that committed `file`, with its merge gate open. */
  async function openMerge(file: string, text = 'worker\n') {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, file), text);
    sh(w.worktreePath!, 'add', '.');
    sh(w.worktreePath!, 'commit', '-qm', file);
    await call('request_merge', { worker: w.id });
    return { run, w, gate: store.gates(run.id).find((g) => g.kind === 'merge')! };
  }
  const expectFailed = (runId: string, gateId: number, reason: RegExp) => {
    expect(store.gate(gateId)!.status).toBe('failed');
    const decided = store.events(runId).filter((e) => e.type === 'gate_decided' && e.data.gate === gateId);
    expect(decided.map((e) => e.data.status)).toEqual(['failed']);
    expect(String(decided[0].data.reason)).toMatch(reason);
    expect(store.events(runId).find((e) => e.type === 'merge')!.data).toMatchObject({ ok: false });
    expect(store.messages(runId).filter((m) => m.kind === 'gate' && m.body.includes(`merge FAILED`))).toHaveLength(1);
  };

  it('a dirty lead tree fails the merge: the gate is failed, not approved, and the worker stays mergeable', async () => {
    const { run, w, gate } = await openMerge('shared.txt');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'uncommitted lead edit\n'); // would be overwritten
    const head = sh(repo, 'rev-parse', 'HEAD');
    await broker.decideGate(gate.id, true, null);
    await broker.settle();
    expectFailed(run.id, gate.id, /.+/);
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')).toBe('uncommitted lead edit\n');
    expect(store.agent(w.id)!.status).not.toBe('merged');
    expect(fs.existsSync(w.worktreePath!)).toBe(true);
    // Not stuck: the lead can request the merge again once the tree is clean.
    fs.rmSync(path.join(repo, 'shared.txt'));
    expect((await call('request_merge', { worker: w.id })).text).toMatch(/submitted as gate/);
  });

  it('a conflict fails the merge and lists the conflicting files', async () => {
    const { run, gate } = await openMerge('README.md', 'worker\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'lead\n');
    sh(repo, 'commit', '-qam', 'lead edit');
    await broker.decideGate(gate.id, true, null);
    await broker.settle();
    expectFailed(run.id, gate.id, /merge conflict/);
    expect(store.messages(run.id).find((m) => m.body.includes('merge FAILED'))!.body).toMatch(/- README.md/);
    expect(sh(repo, 'status', '--porcelain')).toBe('');
  });

  it('a merge that throws fails the gate and still tells the lead', async () => {
    const { run, w, gate } = await openMerge('t.txt');
    broker = new Broker({
      store, cloudcli: cc, prompts: filePrompts(PROMPTS), now: () => clock,
      git: { ...Git, merge: async () => { throw new Error('fatal: bad object deadbeef\nmore detail'); } },
    });
    const decided = await broker.decideGate(gate.id, true, null);
    await broker.settle();
    expect(decided.status).toBe('failed');
    expectFailed(run.id, gate.id, /^fatal: bad object deadbeef$/);
    expect(store.agent(w.id)!.status).not.toBe('merged');
  });

  it('a successful merge is approved exactly once', async () => {
    const { run, gate } = await openMerge('ok.txt');
    await broker.decideGate(gate.id, true, null);
    await broker.settle();
    expect(store.gate(gate.id)!.status).toBe('approved');
    expect(store.events(run.id).filter((e) => e.type === 'gate_decided' && e.data.gate === gate.id).map((e) => e.data.status)).toEqual(['approved']);
  });
});

describe('stalled ending runs (third review)', () => {
  /** Backdates a run's ending_at, as if endRun had marked it `ms` ago. */
  const age = (runId: string, ms: number) => (store as unknown as { db: DatabaseSync }).db
    .prepare('UPDATE runs SET ending_at = ? WHERE id = ?').run(new Date(Date.now() - ms).toISOString(), runId);

  it('the state marks the run ending and diagnostics list it with its age', async () => {
    const run = await startApprovedRun();
    store.markEnding(run.id);
    age(run.id, 90_000);
    expect(broker.state(null, run.id).runs.find((r) => r.id === run.id)).toMatchObject({ status: 'active', ending: true });
    const diag = store.diagnostics();
    expect(diag.endingRuns).toEqual([{ runId: run.id, endingAt: expect.any(String), ageMs: expect.any(Number) }]);
    expect(diag.endingRuns[0].ageMs).toBeGreaterThanOrEqual(90_000);
  });

  it('tick finishes a stop stalled longer than ENDING_RETRY_MS, and never clears ending_at', async () => {
    const run = await startApprovedRun();
    await call('submit_plan', { plan: 'v2' }); // a pending gate the stop must expire
    const gate = store.gates(run.id).find((g) => g.status === 'pending')!;
    store.markEnding(run.id); // endRun marked it, then died before stopRun (no restart)
    age(run.id, ENDING_RETRY_MS - 5_000);
    await broker.tick();
    await broker.settle();
    expect(store.run(run.id)!.status).toBe('active'); // not yet: it may still be legitimately waiting for the lock
    age(run.id, ENDING_RETRY_MS + 5_000);
    await broker.tick();
    await broker.settle();
    expect(store.run(run.id)!.status).toBe('ended');
    expect(store.gate(gate.id)!.status).toBe('expired');
    expect(store.events(run.id).filter((e) => e.type === 'run_ended').map((e) => e.data)).toEqual([{ recovered: true, retried: true }]);
    const raw = (store as unknown as { db: DatabaseSync }).db.prepare('SELECT ending_at FROM runs WHERE id = ?').get(run.id) as { ending_at: string | null };
    expect(raw.ending_at).not.toBeNull();
    await broker.tick();
    await broker.settle();
    expect(store.events(run.id).filter((e) => e.type === 'run_ended')).toHaveLength(1);
  });

  it('tick leaves a run alone while an endRun for it is in progress in this process', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    // Hold the repository lock with a request_merge blocked in commitAll, so endRun waits for it.
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    broker = new Broker({
      store, cloudcli: cc, prompts: filePrompts(PROMPTS), now: () => clock,
      git: { ...Git, commitAll: async (...args: Parameters<typeof Git.commitAll>) => { entered(); await hold; return Git.commitAll(...args); } },
    });
    const merging = broker.handleTool({ tool: 'request_merge', args: { worker: w.id }, caller: LEAD });
    await inside;
    const ending = broker.endRun(run.id, false);
    await new Promise((r) => setTimeout(r, 10));
    age(run.id, ENDING_RETRY_MS + 60_000);
    await broker.tick(); // must not queue a second stop behind the waiting endRun
    expect(store.run(run.id)!.status).toBe('active');
    release();
    await merging;
    await ending;
    await broker.settle();
    expect(store.run(run.id)!.status).toBe('ended');
    expect(store.events(run.id).filter((e) => e.type === 'run_ended').map((e) => e.data)).toEqual([{ removeWorktrees: false }]);
  });
});

describe('turn usage', () => {
  /** Stream events only (what onEvent receives): drop the route's session-id/done objects. */
  const stream = (events: Record<string, unknown>[]) => events.filter((e) => e.type !== 'session-id' && e.type !== 'done');

  it('writes a row when the turn is accepted and finishes it with the last usage event (Codex: summed per turn)', async () => {
    const run = await startApprovedRun();
    cc.events.push(stream(CODEX_TURN));
    const w = await spawn('reviewer', 'review it', 'codex');
    const [t1] = store.turns(w.id);
    expect(t1).toMatchObject({ outcome: 'ok', usageKind: 'turn', inputTokens: 15_000, outputTokens: 300, contextTokens: null, contextWindow: null });
    expect(t1.endedAt).not.toBeNull();
    expect(t1.durationMs).toBeGreaterThanOrEqual(0);
    const ends = store.events(run.id).filter((e) => e.type === 'turn_end' && e.agentId === w.id);
    expect(ends.at(-1)!.data).toMatchObject({ ok: true, turn: t1.id });

    cc.events.push([codexBudget(20_000, 700)]);
    await call('send_message', { to: w.id, body: 'again' });
    const u = store.agent(w.id)!.usage;
    expect(u).toMatchObject({ turns: 2, inputTokens: 35_000, outputTokens: 1_000, lastContextTokens: null, contextWindow: null, currentTurnMs: null });
    expect(u.totalMs).not.toBeNull();
  });

  it('Claude snapshots: the last one in a turn wins, and they are never summed across turns', async () => {
    const run = await startApprovedRun();
    cc.events.push(stream(CLAUDE_TURN));
    const w = await spawn('planner', 'plan it', 'claude');
    expect(store.turns(w.id)[0]).toMatchObject({
      usageKind: 'context', contextTokens: 45_310, contextWindow: 200_000, inputTokens: 44_810, outputTokens: 500,
      cacheReadTokens: 40_000, cacheCreationTokens: 4_400,
    });
    cc.events.push([claudeBudget(52_000, 51_500, 500)]);
    await call('send_message', { to: w.id, body: 'more' });
    const u = store.agent(w.id)!.usage;
    // Not 45k + 52k: a snapshot is the conversation so far, so it is reported as the latest value only.
    expect(u).toMatchObject({ turns: 2, lastContextTokens: 52_000, contextWindow: 200_000, inputTokens: null, outputTokens: null });

    // Run totals: every broker turn counts (lead included); tokens only from summable (per-turn) usage.
    cc.events.push(stream(CODEX_TURN));
    await spawn('reviewer', 'review', 'codex');
    const ru = store.run(run.id)!.usage;
    const all = store.agents(run.id).reduce((n, a) => n + a.usage.turns, 0);
    expect(ru).toMatchObject({ turns: all, inputTokens: 15_000, outputTokens: 300 });
  });

  it('an error after acceptance closes the row as error; a 409 or an error before acceptance writes none', async () => {
    await startApprovedRun();
    cc.next.push('busy', 'ok');
    const w = await spawn('planner', 'a', 'claude');
    expect(store.turns(w.id)).toHaveLength(0); // 409: no turn
    clock += 10 * 60_000;
    await broker.tick(); await broker.settle();
    expect(store.turns(w.id).map((t) => t.outcome)).toEqual(['ok']);

    cc.next.push('error');
    await call('send_message', { to: w.id, body: 'b' });
    expect(store.turns(w.id)).toHaveLength(1); // refused before acceptance: no turn

    clock += 10 * 60_000;
    cc.next.push('accepted-error');
    cc.events.push([claudeBudget(10_000, 9_000, 1_000)]);
    await broker.tick(); await broker.settle();
    const last = store.turns(w.id).at(-1)!;
    expect(last).toMatchObject({ outcome: 'error', contextTokens: 10_000 });
    expect(last.endedAt).not.toBeNull();
  });

  it('a turn open across a restart is closed as interrupted, keeping the usage seen so far', async () => {
    await startApprovedRun();
    cc.next.push('hold');
    cc.events.push([claudeBudget(8_000, 7_900, 100)]);
    const r = await broker.handleTool({ tool: 'spawn_agent', args: { role: 'coder', task: 'x' }, caller: LEAD });
    const id = r.text.match(/Spawned (\S+)/)![1];
    await new Promise((x) => setTimeout(x, 0));
    const open = store.agent(id)!.usage;
    expect(open.turns).toBe(1);
    expect(open.currentTurnMs).not.toBeNull();
    expect(store.turns(id)[0]).toMatchObject({ outcome: null, endedAt: null, contextTokens: 8_000 });

    store.close();
    store = new Store(path.join(tmp, 'db.sqlite'));
    cc = Object.assign(new FakeCloudCli(), { sessions: cc.sessions });
    broker = new Broker({ store, cloudcli: cc, git: Git, prompts: filePrompts(PROMPTS), now: () => clock });
    await broker.recover();
    await broker.settle();
    const [t] = store.turns(id);
    expect(t).toMatchObject({ outcome: 'interrupted', durationMs: null, contextTokens: 8_000 });
    expect(t.endedAt).not.toBeNull();
    expect(store.agent(id)!.usage).toMatchObject({ turns: 1, currentTurnMs: null, lastContextTokens: 8_000 });
  });

  it('durations come from the store clock; unknown usage stays null', () => {
    let now = Date.UTC(2026, 10, 25, 9, 0, 0);
    const s2 = new Store(path.join(tmp, 'clock.sqlite'), () => new Date(now));
    s2.createRun('r1', 'lead-1', '/x');
    s2.createAgent({ id: 'w1', runId: 'r1', role: 'coder', provider: 'claude', cwd: '/x', status: 'running' });
    expect(s2.agent('w1')!.usage).toEqual({
      turns: 0, totalMs: null, currentTurnMs: null, lastContextTokens: null, contextWindow: null, inputTokens: null, outputTokens: null,
    });
    const t = s2.startTurn('w1', 'r1');
    now += 5_000;
    expect(s2.agent('w1')!.usage).toMatchObject({ turns: 1, totalMs: 5_000, currentTurnMs: 5_000 });
    now += 7_000;
    s2.finishTurn(t, 'ok');
    s2.finishTurn(t, 'error'); // closing twice is a no-op
    expect(s2.turns('w1')[0]).toMatchObject({ outcome: 'ok', durationMs: 12_000 });
    expect(s2.agent('w1')!.usage).toMatchObject({ turns: 1, totalMs: 12_000, currentTurnMs: null, inputTokens: null });
    expect(s2.run('r1')!.usage).toEqual({ turns: 1, totalMs: 12_000, inputTokens: null, outputTokens: null });
    s2.close();
  });

  it('adds the turns table to an older database idempotently', () => {
    const file = path.join(tmp, 'old.sqlite');
    const s1 = new Store(file);
    s1.close();
    // Simulate a database from before this table existed.
    const raw = new DatabaseSync(file);
    raw.exec('DROP TABLE turns');
    raw.close();
    const s2 = new Store(file);
    s2.close();
    const s3 = new Store(file);
    expect(s3.diagnostics().schema.missingColumns).toEqual({});
    s3.close();
  });
});

describe('turn usage (review rework)', () => {
  it('run totals count every open turn at once; per-agent current time is its own turn', () => {
    let now = Date.UTC(2026, 10, 25, 9, 0, 0);
    const s2 = new Store(path.join(tmp, 'concurrent.sqlite'), () => new Date(now));
    s2.createRun('r1', 'lead-1', '/x');
    for (const id of ['lead-1', 'w1', 'w2']) s2.createAgent({ id, runId: 'r1', role: id === 'lead-1' ? 'lead' : 'coder', provider: 'claude', cwd: '/x', status: 'running' });
    const tl = s2.startTurn('lead-1', 'r1');
    now += 2_000;
    s2.startTurn('w1', 'r1');
    now += 3_000;
    s2.startTurn('w2', 'r1');
    now += 1_000;
    // Open: lead 6s, w1 4s, w2 1s.
    expect(s2.run('r1')!.usage).toMatchObject({ turns: 3, totalMs: 11_000 });
    const byId = new Map(s2.agents('r1').map((a) => [a.id, a.usage]));
    expect(byId.get('w1')).toMatchObject({ currentTurnMs: 4_000, totalMs: 4_000 });
    expect(byId.get('w2')).toMatchObject({ currentTurnMs: 1_000, totalMs: 1_000 });
    // Closing a turn does not make the run total jump: its elapsed time simply becomes its duration.
    s2.finishTurn(tl, 'ok');
    expect(s2.run('r1')!.usage.totalMs).toBe(11_000);
    expect(s2.runSummaries()[0].usage.totalMs).toBe(11_000);
    s2.close();
  });

  it('a turn the user aborted is closed as aborted: no retry, no error, the worker goes idle and the lead is told', async () => {
    const run = await startApprovedRun();
    cc.next.push('aborted');
    cc.events.push([claudeBudget(9_000, 8_800, 200)]);
    const w = await spawn('planner', 'abort me', 'claude');
    expect(store.turns(w.id)[0]).toMatchObject({ outcome: 'aborted', contextTokens: 9_000 });
    expect(store.agent(w.id)).toMatchObject({ status: 'idle', lastError: null });
    expect(store.messages(run.id).find((m) => m.to === w.id)!.state).toBe('delivered');
    expect(store.events(run.id).filter((e) => e.type === 'turn_end' && e.agentId === w.id).at(-1)!.data).toMatchObject({ ok: false, aborted: true });
    const note = store.messages(run.id).filter((m) => m.to === run.leadAgentId && m.kind === 'system').at(-1)!;
    expect(note.body).toMatch(/aborted/);
    expect(note.body).not.toMatch(/failed/);
    clock += 10 * 60_000;
    await broker.tick(); await broker.settle();
    expect(cc.calls.filter((c) => /abort me/.test(c.message))).toHaveLength(1);
  });

  it('/state does a constant number of queries however many runs and turns exist', async () => {
    await startApprovedRun();
    const db = (store as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const count = () => {
      let n = 0;
      const orig = db.prepare.bind(db);
      db.prepare = (sql: string) => { n++; return orig(sql); };
      broker.state('lead-app', null);
      db.prepare = orig;
      return n;
    };
    const before = count();
    for (let i = 0; i < 15; i++) {
      store.createRun(`r-old${i}`, `lead-old${i}`, repo);
      for (const k of [0, 1, 2]) {
        store.createAgent({ id: `w-old${i}-${k}`, runId: `r-old${i}`, role: 'coder', provider: 'claude', cwd: repo, status: 'idle' });
        store.finishTurn(store.startTurn(`w-old${i}-${k}`, `r-old${i}`), 'ok');
      }
    }
    expect(count()).toBe(before);
    expect(broker.state('lead-app', null).runs.find((r) => r.id === 'r-old3')).toMatchObject({ agentCount: 3, pendingGates: 0, usage: { turns: 3 } });
  });

  it('exports the migration list; pendingMigrations sees what an older database lacks', () => {
    expect(MIGRATIONS.map((m) => m.table)).toContain('turns');
    const file = path.join(tmp, 'pending.sqlite');
    new Store(file).close();
    const raw = new DatabaseSync(file);
    expect(pendingMigrations(raw)).toEqual([]);
    raw.exec('DROP TABLE turns');
    raw.exec('DROP INDEX messages_delivery');
    expect(pendingMigrations(raw)).toEqual(['index messages_delivery', 'table turns', 'index turns_run_agent_id']);
    raw.close();
    new Store(file).close();
    const again = new DatabaseSync(file, { readOnly: true });
    expect(pendingMigrations(again)).toEqual([]);
    again.close();
  });
});

describe('quota pauses and auto-resume (Q41)', () => {
  const CODEX_LIMIT = "You've hit your usage limit. To get more access now, send a request to your admin or try again at 7:13 PM.";
  const CLAUDE_LIMIT = "Claude Code returned an error result: You've hit your 5-hour limit · resets 7:10pm (UTC)";
  const T0 = Date.parse('2026-11-26T18:00:00Z');
  const sends = (id: string) => cc.calls.filter((c) => c.projectPath === store.agent(id)!.cwd && c.sessionId !== 'lead-app');
  const resumeMsgs = (id: string) => sends(id).filter((c) => /previous turn was interrupted/.test(c.message));
  const restart = () => {
    store.close();
    store = new Store(path.join(tmp, 'db.sqlite'));
    cc = Object.assign(new FakeCloudCli(), { sessions: cc.sessions, live: cc.live, calls: cc.calls });
    broker = new Broker({ store, cloudcli: cc, git: Git, prompts: filePrompts(PROMPTS), now: () => clock });
  };
  async function pausedCoder(limit = CODEX_LIMIT) {
    clock = T0;
    const run = await startApprovedRun();
    cc.next.push('accepted-error');
    cc.errorText.push(limit);
    const w = await spawn('coder', 'build the feature');
    return { run, w: store.agent(w.id)! };
  }

  it('pauses on a usage limit (not error), tells the lead, then resumes the same session at the reset time', async () => {
    const { run, w } = await pausedCoder();
    expect(w).toMatchObject({ status: 'paused', pauseReason: 'usage limit', resumeAt: '2026-11-26T19:14:00.000Z', lastError: CODEX_LIMIT });
    const app = w.appSessionId!;
    expect(app).toBeTruthy();
    expect(store.events(run.id).find((e) => e.type === 'paused')!.data).toMatchObject({ reason: 'usage limit', resumeAt: '2026-11-26T19:14:00.000Z' });
    const note = cc.calls.filter((c) => c.sessionId === 'lead-app').at(-1)!;
    expect(note.message).toContain(`${w.id} paused (usage limit), auto-resume at 2026-11-26 19:14 UTC`);
    expect(store.agents(run.id).find((a) => a.id === w.id)!.status).toBe('paused');

    // Not before its time; messages from the lead wait for the resume.
    clock = Date.parse('2026-11-26T19:00:00Z');
    const queued = await call('send_message', { to: w.id, body: 'also add docs' });
    expect(queued.text).toMatch(/paused by a provider usage limit until 2026-11-26 19:14 UTC/);
    await broker.tick(); await broker.settle();
    expect(sends(w.id)).toHaveLength(1);

    clock = Date.parse('2026-11-26T19:15:00Z');
    await broker.tick(); await broker.settle();
    const resumed = sends(w.id).slice(1);
    expect(resumed).toHaveLength(1);
    expect(resumed[0].sessionId).toBe(app); // the same CloudCLI session
    expect(resumed[0].message).toMatch(/Your previous turn was interrupted \(usage limit\)\. Check your worktree state \(git status \/ git diff\)/);
    expect(resumed[0].message).toContain('also add docs');
    expect(store.agent(w.id)).toMatchObject({ status: 'idle', appSessionId: app, resumeAt: null, pauseReason: null });
    expect(store.events(run.id).find((e) => e.type === 'resumed')!.data).toMatchObject({ by: 'auto', from: 'paused' });
    await broker.tick(); await broker.settle();
    expect(resumeMsgs(w.id)).toHaveLength(1); // never repeated
  });

  it('a resume that hits the limit again re-pauses with a fresh time; each pause resumes exactly once', async () => {
    const { w } = await pausedCoder();
    clock = Date.parse('2026-11-26T19:15:00Z');
    cc.next.push('accepted-error');
    cc.errorText.push(CLAUDE_LIMIT); // resets 7:10pm (UTC): already past today → tomorrow
    await broker.tick(); await broker.settle();
    expect(store.agent(w.id)).toMatchObject({ status: 'paused', resumeAt: '2026-11-27T19:11:00.000Z' });
    expect(resumeMsgs(w.id)).toHaveLength(1);
    for (let i = 0; i < 3; i++) { clock += 60_000; await broker.tick(); await broker.settle(); }
    expect(resumeMsgs(w.id)).toHaveLength(1);

    clock = Date.parse('2026-11-27T19:12:00Z');
    await broker.tick(); await broker.settle();
    expect(resumeMsgs(w.id)).toHaveLength(2);
    expect(store.agent(w.id)!.status).toBe('idle');
  });

  it('a limit hit before CloudCLI accepted the turn pauses too, and the requeued task is delivered on resume', async () => {
    clock = T0;
    await startApprovedRun();
    cc.next.push('error');
    cc.errorText.push('HTTP 429: Too Many Requests');
    const w = await spawn('planner', 'plan the thing');
    expect(store.agent(w.id)).toMatchObject({ status: 'paused', pauseReason: 'rate limit', resumeAt: '2026-11-26T18:30:00.000Z' });
    expect(store.undelivered(w.id)).toHaveLength(1);
    await broker.tick(); await broker.settle();
    expect(sends(w.id)).toHaveLength(1); // no retry storm while paused

    clock = Date.parse('2026-11-26T18:31:00Z');
    await broker.tick(); await broker.settle();
    expect(sends(w.id)).toHaveLength(2);
    expect(sends(w.id)[1].message).toContain('plan the thing');
    expect(sends(w.id)[1].message).not.toMatch(/previous turn was interrupted/); // it never saw a turn
  });

  it('uses the configured backoff when the reset time cannot be read', async () => {
    broker.setQuotaBackoffMinutes(45);
    const { w } = await pausedCoder("You've hit your usage limit. Upgrade your plan.");
    expect(store.agent(w.id)!.resumeAt).toBe(new Date(T0 + 45 * 60_000).toISOString());
    expect(() => broker.setQuotaBackoffMinutes(-1)).toThrow(/quotaBackoffMinutes/);
  });

  it('a paused worker survives a restart (stays paused) and still auto-resumes', async () => {
    const { w } = await pausedCoder();
    restart();
    const res = await broker.recover();
    await broker.settle();
    expect(res.interrupted).toEqual([]);
    expect(store.agent(w.id)).toMatchObject({ status: 'paused', resumeAt: '2026-11-26T19:14:00.000Z' });
    clock = Date.parse('2026-11-26T19:15:00Z');
    await broker.tick(); await broker.settle();
    expect(resumeMsgs(w.id)).toHaveLength(1);
    expect(resumeMsgs(w.id)[0].sessionId).toBe(w.appSessionId);
  });

  it('ending a paused worker cancels its resume', async () => {
    const { run, w } = await pausedCoder();
    expect((await call('end_agent', { worker: w.id })).ok).toBe(true);
    expect(store.agent(w.id)).toMatchObject({ status: 'ended', resumeAt: null });
    expect(store.events(run.id).find((e) => e.type === 'agent_ended')!.data).toMatchObject({ cancelledResume: true });
    clock = Date.parse('2026-11-27T00:00:00Z');
    await broker.tick(); await broker.settle();
    expect(resumeMsgs(w.id)).toHaveLength(0);
  });

  it('no resume in a run that is ending', async () => {
    const { run, w } = await pausedCoder();
    store.markEnding(run.id);
    clock = Date.parse('2026-11-26T19:15:00Z');
    await broker.tick(); await broker.settle();
    expect(resumeMsgs(w.id)).toHaveLength(0);
  });

  it('a paused worker keeps its slot, even a read-only one', async () => {
    clock = T0;
    await startApprovedRun();
    cc.next.push('accepted-error');
    cc.errorText.push(CODEX_LIMIT);
    const p = await spawn('planner');
    expect(store.agent(p.id)!.status).toBe('paused');
    for (let i = 0; i < MAX_WORKERS - 1; i++) await spawn('coder');
    const full = await call('spawn_agent', { role: 'planner', task: 't' });
    expect(full.ok).toBe(false);
    expect(full.text).toContain(`${p.id} paused`);
  });

  it('wait_for_agents returns early on a pause, says until when, and waits again afterwards', async () => {
    clock = T0;
    await startApprovedRun();
    cc.next.push('hold');
    const raw = (tool: ToolName, args: Record<string, unknown>) => broker.handleTool({ tool, args, caller: LEAD });
    const spawned = await raw('spawn_agent', { role: 'coder', task: 't' });
    const w = store.agent(spawned.text.match(/Spawned (\S+)/)![1])!;
    await new Promise((x) => setTimeout(x, 0));
    expect((await raw('wait_for_agents', {})).pending).toBe(true);
    cc.holdError.push(CODEX_LIMIT);
    cc.holds.shift()!();
    await broker.settle();
    const r = await call('wait_for_agents', {});
    expect(r.pending).toBeFalsy();
    expect(r.text).toContain(`${w.id} paused (usage limit), auto-resume at 2026-11-26 19:14 UTC`);
    expect(r.text).toMatch(new RegExp(`${w.id} paused until 2026-11-26 19:14 UTC`));
    expect(r.text).toMatch(/Usually just call wait_for_agents again/);
    expect(r.text).toMatch(new RegExp(`Waited on: ${w.id}\\.$`));
    const again = await call('wait_for_agents', {});
    expect(again.pending).toBe(true);
    expect(again.text).toContain('paused until');
  });

  it('the tab Resume: "Resume now" skips the wait; failed/interrupted workers resume once; others are refused', async () => {
    const { run, w } = await pausedCoder();
    expect(broker.resumeWorker(w.id, 'user')).toMatch(/Resumed/);
    await broker.settle();
    expect(resumeMsgs(w.id)).toHaveLength(1);
    expect(store.events(run.id).find((e) => e.type === 'resumed')!.data).toMatchObject({ by: 'user' });
    expect(() => broker.resumeWorker(w.id, 'user')).toThrow(/idle; only paused, failed or interrupted/);

    cc.next.push('accepted-error'); // an ordinary failure: error, and never retried automatically
    await call('send_message', { to: w.id, body: 'more' });
    expect(store.agent(w.id)!.status).toBe('error');
    clock += 3_600_000;
    await broker.tick(); await broker.settle();
    expect(resumeMsgs(w.id)).toHaveLength(1);
    broker.resumeWorker(w.id, 'user');
    await broker.settle();
    expect(resumeMsgs(w.id)).toHaveLength(2);
    expect(resumeMsgs(w.id)[1].message).toMatch(/interrupted \(error: died mid-turn\)/);
  });

  it('Cancel auto-resume makes it interrupted and tells the lead; nothing resumes by itself', async () => {
    const { w } = await pausedCoder();
    expect(broker.cancelAutoResume(w.id)).toMatch(/Cancelled/);
    await broker.settle();
    expect(store.agent(w.id)).toMatchObject({ status: 'interrupted', resumeAt: null });
    expect(cc.calls.filter((c) => c.sessionId === 'lead-app').at(-1)!.message).toMatch(/cancelled the auto-resume/);
    clock = Date.parse('2026-11-27T00:00:00Z');
    await broker.tick(); await broker.settle();
    expect(resumeMsgs(w.id)).toHaveLength(0);
    expect(() => broker.cancelAutoResume(w.id)).toThrow(/not paused/);
  });

  it('adds the pause columns to an older database idempotently', () => {
    const file = path.join(tmp, 'old-agents.sqlite');
    new Store(file).close();
    const raw = new DatabaseSync(file);
    for (const c of ['resume_at', 'pause_reason', 'pause_nudge']) raw.exec(`ALTER TABLE agents DROP COLUMN ${c}`);
    expect(pendingMigrations(raw)).toEqual(['column agents.resume_at', 'column agents.pause_reason', 'column agents.pause_nudge']);
    raw.close();
    new Store(file).close();
    new Store(file).close();
    const again = new DatabaseSync(file, { readOnly: true });
    expect(pendingMigrations(again)).toEqual([]);
    again.close();
  });
});

describe('child sessions (Q45)', () => {
  const toWorker = (id: string) => cc.calls.filter((c) => c.projectPath === store.agent(id)!.cwd && c.sessionId !== 'lead-app');
  const has = (c: SendInput) => Object.prototype.hasOwnProperty.call(c, 'parentSessionId') && c.parentSessionId != null;

  it("a worker's first turn nests its new session under the lead when the host supports it", async () => {
    cc.childSessions = true;
    await startApprovedRun();
    const w = await spawn('coder');
    const [first] = toWorker(w.id);
    expect(first.sessionId ?? null).toBeNull();
    expect(first.parentSessionId).toBe('lead-app');
    expect(cc.parents.get(store.agent(w.id)!.appSessionId!)).toBe('lead-app');
  });

  it('falls back to the lead provider session id when its app id is unknown', async () => {
    cc.childSessions = true;
    const run = await startApprovedRun();
    store.updateAgent(run.leadAgentId, { appSessionId: null });
    const w = await spawn('coder');
    expect(toWorker(w.id)[0].parentSessionId).toBe('lead-prov');
  });

  it.each([['missing', false], ['unknown', null]] as const)('is absent when the capability is %s', async (_label, cap) => {
    cc.childSessions = cap;
    await startApprovedRun();
    const w = await spawn('coder');
    expect(toWorker(w.id).some(has)).toBe(false);
  });

  it('continuation turns and the lead own turns never carry it, so the host cannot answer 400', async () => {
    cc.childSessions = true;
    await startApprovedRun();
    const w = await spawn('coder');
    await call('send_message', { to: w.id, body: 'also add a test' });
    await call('send_message', { to: w.id, body: 'and docs' });
    const calls = toWorker(w.id);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.slice(1).every((c) => c.sessionId && !has(c))).toBe(true);
    expect(cc.calls.filter((c) => c.sessionId === 'lead-app').some(has)).toBe(false);
    expect(store.agent(w.id)!.status).not.toBe('error');
  });

  it("handoff_agent's new worker nests under the lead", async () => {
    cc.childSessions = true;
    await startApprovedRun();
    const old = await spawn('reviewer', 'review the diff', 'codex');
    store.updateAgent(old.id, { status: 'error', lastError: 'Codex usage limit' });
    const r = await call('handoff_agent', { worker: old.id, provider: 'claude' });
    expect(r.ok, r.text).toBe(true);
    const id = r.text.match(/off to (\S+)/)![1];
    const first = cc.calls.filter((c) => c.sessionId == null).at(-1)!; // the new worker's session-creating turn
    expect(first.message).toContain('review the diff');
    expect(first.parentSessionId).toBe('lead-app');
    expect(cc.parents.get(store.agent(id)!.appSessionId!)).toBe('lead-app');
  });

  it('HttpCloudCli sends parentSessionId only for a new session and caches childSessions from capabilities', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-child-'));
    const prev = process.env.COAGENT_API_KEY;
    process.env.COAGENT_API_KEY = 'ck_test';
    try {
      const bodies: Record<string, unknown>[] = [];
      let capsCalls = 0;
      let capsOk = false;
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/agent/capabilities')) {
          capsCalls++;
          return capsOk ? Response.json({ sessionStatus: true, childSessions: true }) : new Response('nope', { status: 500 });
        }
        bodies.push(JSON.parse(String(init!.body)));
        return new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('data: {"type":"session-id","sessionId":"a"}\n\n')); ctl.close(); } }));
      }) as unknown as typeof fetch;
      const http = new HttpCloudCli({ pluginsConfigPath: path.join(dir, 'none.json'), localServerPath: path.join(dir, 'none.json'), fetchImpl });
      expect(await http.capabilities()).toEqual({ sessionStatus: null, childSessions: null }); // not cached
      capsOk = true;
      expect(await http.capabilities()).toEqual({ sessionStatus: true, childSessions: true });
      expect(await http.capabilities()).toEqual({ sessionStatus: true, childSessions: true });
      expect(capsCalls).toBe(2);
      await http.send({ projectPath: '/p', provider: 'claude', message: 'm', parentSessionId: 'lead-app' });
      await http.send({ projectPath: '/p', provider: 'claude', message: 'm', sessionId: 'a', parentSessionId: 'lead-app' });
      expect(bodies[0]).toMatchObject({ projectPath: '/p', provider: 'claude', parentSessionId: 'lead-app' });
      expect(bodies[0]).not.toHaveProperty('sessionId');
      expect(bodies[1]).toMatchObject({ sessionId: 'a' });
      expect(bodies[1]).not.toHaveProperty('parentSessionId');
    } finally {
      if (prev === undefined) delete process.env.COAGENT_API_KEY; else process.env.COAGENT_API_KEY = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('handoff_agent (Q42)', () => {
  const lastTo = (id: string) => cc.calls.filter((c) => c.projectPath === store.agent(id)!.cwd && c.sessionId !== 'lead-app').at(-1)!;

  it('a writer: the new worktree starts at the old HEAD with every committed, uncommitted and untracked change', async () => {
    const run = await startApprovedRun();
    const old = await spawn('coder', 'implement the parser');
    const wt = old.worktreePath!;
    fs.writeFileSync(path.join(wt, 'done.txt'), 'committed\n');
    sh(wt, 'add', 'done.txt');
    sh(wt, 'commit', '-q', '-m', 'part 1');
    const oldHead = sh(wt, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(wt, 'README.md'), 'base\nedited\n'); // tracked, unstaged
    fs.writeFileSync(path.join(wt, 'staged.txt'), 'staged\n');
    sh(wt, 'add', 'staged.txt'); // staged, new
    fs.rmSync(path.join(wt, 'done.txt')); // deleted
    fs.mkdirSync(path.join(wt, 'src'));
    fs.writeFileSync(path.join(wt, 'src', 'new.ts'), 'export {};\n'); // untracked
    fs.writeFileSync(path.join(wt, 'bin.dat'), Buffer.from([0, 1, 2, 255, 0, 10])); // untracked binary
    fs.writeFileSync(path.join(wt, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(wt, '.gitignore'), 'ignored.log\n');
    fs.writeFileSync(path.join(wt, 'ignored.log'), 'noise\n');
    const oldStatus = sh(wt, 'status', '--porcelain');
    store.pauseAgent(old.id, new Date(clock + 3_600_000).toISOString(), 'usage limit', true, 'You hit your usage limit');
    store.activity.set(old.id, [{ ts: 'x', text: 'Edit: src/parser.ts' }, { ts: 'y', text: 'Bash: npm test' }]);
    await call('send_message', { to: old.id, body: 'remember the edge case' }); // queued: it is paused

    const r = await call('handoff_agent', { worker: old.id, provider: 'codex', note: 'reviewer: handle empty input' });
    expect(r.ok, r.text).toBe(true);
    const id = r.text.match(/off to (\S+)/)![1];
    const nw = store.agent(id)!;
    expect(nw).toMatchObject({ role: 'coder', provider: 'codex' });
    expect(nw.branch).toBe(`coagent/${run.id}/${id}`);
    const nwt = nw.worktreePath!;
    expect(sh(nwt, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(fs.readFileSync(path.join(nwt, 'README.md'), 'utf8')).toBe('base\nedited\n');
    expect(fs.readFileSync(path.join(nwt, 'staged.txt'), 'utf8')).toBe('staged\n');
    expect(fs.existsSync(path.join(nwt, 'done.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(nwt, 'src', 'new.ts'), 'utf8')).toBe('export {};\n');
    expect([...fs.readFileSync(path.join(nwt, 'bin.dat'))]).toEqual([0, 1, 2, 255, 0, 10]);
    expect(fs.statSync(path.join(nwt, 'run.sh')).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(nwt, 'ignored.log'))).toBe(false); // ignored files are not carried
    // Same content, all as uncommitted changes (the staged file becomes untracked: nothing is lost).
    expect((await Git.snapshotWorkingTree(nwt)).tree).toBe((await Git.snapshotWorkingTree(wt)).tree);
    expect(sh(nwt, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.trim().split(/\s+/).at(-1)).sort())
      .toEqual(['.gitignore', 'README.md', 'bin.dat', 'done.txt', 'run.sh', 'src/new.ts', 'staged.txt']);
    // The old worktree is untouched, including its index.
    expect(sh(wt, 'status', '--porcelain')).toBe(oldStatus);
    expect(store.agent(old.id)).toMatchObject({ status: 'ended', worktreePath: wt, resumeAt: null });

    const ev = store.events(run.id);
    expect(ev.find((e) => e.type === 'handoff')).toMatchObject({ agentId: old.id, data: { from: old.id, to: id, provider: 'codex' } });
    expect(ev.find((e) => e.type === 'agent_ended' && e.agentId === old.id)!.data).toMatchObject({ handoff: id });
    expect(ev.find((e) => e.type === 'spawned' && e.agentId === id)!.data).toMatchObject({ handoffFrom: old.id });

    const first = lastTo(id);
    expect(first.provider).toBe('codex');
    expect(first.sessionId ?? null).toBeNull(); // a new session
    for (const s of ['implement the parser', 'ALREADY IN YOUR WORKTREE', oldHead.slice(0, 10), 'Edit: src/parser.ts',
      'You hit your usage limit', 'remember the edge case', 'reviewer: handle empty input', 'src/new.ts']) {
      expect(first.message).toContain(s);
    }
    expect(store.messages(run.id).find((m) => m.to === old.id && m.body === 'remember the edge case')!.state).toBe('cancelled');
    expect(r.text).toMatch(/uncommitted path\(s\) carried over \(verified identical\)/);
  });

  it('a read-only worker just starts on the other provider in the lead directory', async () => {
    const run = await startApprovedRun();
    const old = await spawn('reviewer', 'review the diff', 'codex');
    store.updateAgent(old.id, { status: 'error', lastError: 'Codex usage limit' });
    const r = await call('handoff_agent', { worker: old.id, provider: 'claude' });
    expect(r.ok, r.text).toBe(true);
    const nw = store.agent(r.text.match(/off to (\S+)/)![1])!;
    expect(nw).toMatchObject({ role: 'reviewer', provider: 'claude', cwd: repo, branch: null, worktreePath: null });
    expect(store.agent(old.id)!.status).toBe('ended');
    expect(lastTo(nw.id).message).toContain('review the diff');
    expect(store.events(run.id).some((e) => e.type === 'handoff' && e.data.to === nw.id)).toBe(true);
  });

  it('is refused while the worker runs a turn, here or per CloudCLI', async () => {
    await startApprovedRun();
    cc.next.push('hold');
    const spawned = await broker.handleTool({ tool: 'spawn_agent', args: { role: 'coder', task: 't' }, caller: LEAD });
    const busy = store.agent(spawned.text.match(/Spawned (\S+)/)![1])!;
    await new Promise((x) => setTimeout(x, 0));
    const r = await broker.handleTool({ tool: 'handoff_agent', args: { worker: busy.id, provider: 'codex' }, caller: LEAD });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/middle of a turn/);
    cc.holds.shift()!();
    await broker.settle();

    cc.status = () => true; // CloudCLI: still processing (e.g. a turn started from its own tab)
    const r2 = await call('handoff_agent', { worker: busy.id, provider: 'codex' });
    expect(r2.text).toMatch(/still running a turn in CloudCLI/);
    expect(store.agents(busy.runId)).toHaveLength(2);
  });

  it('rejects the pending merge gate of the old worker', async () => {
    const run = await startApprovedRun();
    const old = await spawn('coder');
    fs.writeFileSync(path.join(old.worktreePath!, 'x.txt'), 'x\n');
    await call('request_merge', { worker: old.id });
    const gate = store.gates(run.id).find((g) => g.kind === 'merge')!;
    expect(gate.status).toBe('pending');
    const r = await call('handoff_agent', { worker: old.id, provider: 'codex' });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(new RegExp(`gate #${gate.id}\\) was rejected`));
    expect(store.gate(gate.id)!.status).toBe('rejected');
    // request_merge committed x.txt on the old branch: the new worker starts with it.
    const nw = store.agent(r.text.match(/off to (\S+)/)![1])!;
    expect(fs.readFileSync(path.join(nw.worktreePath!, 'x.txt'), 'utf8')).toBe('x\n');
  });

  it('only the lead can hand off; gone workers and unknown providers are refused', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    const other = await spawn('planner');
    const byWorker = await call('handoff_agent', { worker: other.id, provider: 'codex' }, workerCaller(w.providerSessionId!));
    expect(byWorker.ok).toBe(false);
    expect(byWorker.text).toMatch(/Only the lead/);
    expect((await call('handoff_agent', { worker: w.id, provider: 'gemini' })).text).toMatch(/Unsupported provider/);
    await call('end_agent', { worker: w.id });
    expect((await call('handoff_agent', { worker: w.id, provider: 'codex' })).text).toMatch(/ended; there is nothing to hand off/);
  });

  it('a failed carry-over changes nothing: no new worker, no new worktree, the old worker untouched', async () => {
    const run = await startApprovedRun();
    const old = await spawn('coder');
    fs.writeFileSync(path.join(old.worktreePath!, 'wip.txt'), 'wip\n');
    broker = new Broker({
      store, cloudcli: cc, prompts: filePrompts(PROMPTS), now: () => clock,
      git: { ...Git, restoreWorkingTree: async () => { throw new Error('tree mismatch'); } },
    });
    const before = fs.readdirSync(path.dirname(old.worktreePath!));
    const r = await call('handoff_agent', { worker: old.id, provider: 'codex' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Handoff aborted.*tree mismatch.*Nothing was changed/);
    expect(store.agent(old.id)!.status).toBe('idle');
    expect(store.agents(run.id)).toHaveLength(2);
    expect(fs.readdirSync(path.dirname(old.worktreePath!))).toEqual(before);
    expect(sh(repo, 'branch', '--list', 'coagent/*').split('\n')).toHaveLength(1);
    expect(fs.readFileSync(path.join(old.worktreePath!, 'wip.txt'), 'utf8')).toBe('wip\n');
  });
});

describe('review rework (Q41/Q42)', () => {
  it('handoff is refused when CloudCLI cannot confirm the session is idle (null status)', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    cc.status = () => null;
    const r = await call('handoff_agent', { worker: w.id, provider: 'codex' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/cannot confirm that .* session is idle/);
    expect(r.text).toMatch(/Install the CoAgent CloudCLI fork/);
    expect(store.agent(w.id)!.status).toBe('idle');
    expect(store.agents(w.runId)).toHaveLength(2);
  });

  it('handoff aborts cleanly when the session starts processing between the snapshot and the switch', async () => {
    const run = await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'wip.txt'), 'wip\n');
    let asked = 0;
    cc.status = () => ++asked > 1; // idle on the first check, processing on the re-check
    const before = fs.readdirSync(path.dirname(w.worktreePath!));
    const r = await call('handoff_agent', { worker: w.id, provider: 'codex' });
    expect(asked).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Handoff aborted, nothing was changed: .* still running a turn/);
    expect(store.agent(w.id)!.status).toBe('idle');
    expect(store.agents(run.id)).toHaveLength(2);
    expect(fs.readdirSync(path.dirname(w.worktreePath!))).toEqual(before);
    expect(sh(repo, 'branch', '--list', 'coagent/*').split('\n')).toHaveLength(1);
    expect(store.events(run.id).some((e) => e.type === 'handoff')).toBe(false);
  });

  it('handoff refuses a worktree with dirty submodules and lists them', async () => {
    const lib = path.join(tmp, 'lib');
    fs.mkdirSync(lib);
    sh(lib, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(lib, 'lib.txt'), 'v1\n');
    sh(lib, 'add', '-A');
    sh(lib, 'commit', '-q', '-m', 'lib');
    sh(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
    sh(repo, 'commit', '-q', '-m', 'add submodule');
    await startApprovedRun();
    const w = await spawn('coder');
    sh(w.worktreePath!, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init');
    expect(await Git.dirtySubmodules(w.worktreePath!)).toEqual([]);
    fs.writeFileSync(path.join(w.worktreePath!, 'vendor/lib/lib.txt'), 'v2\n');
    fs.writeFileSync(path.join(w.worktreePath!, 'vendor/lib/new.txt'), 'new\n');
    expect(await Git.dirtySubmodules(w.worktreePath!)).toEqual([{ path: 'vendor/lib', issues: ['modified files', 'untracked files'] }]);
    const r = await call('handoff_agent', { worker: w.id, provider: 'codex' });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Handoff refused: .*submodule\(s\) with work that cannot be carried over: vendor\/lib \(modified files, untracked files\)/);
    expect(store.agent(w.id)!.status).toBe('idle');
    expect(store.agents(w.runId)).toHaveLength(2);
  });

  it('the configured backoff is clamped to the same 7-day cap', () => {
    store.setJson('quotaBackoffMinutes', 1e12);
    expect(broker.quotaBackoffMinutes()).toBe(7 * 24 * 60);
    store.setJson('quotaBackoffMinutes', 'abc');
    expect(broker.quotaBackoffMinutes()).toBe(30);
    expect(() => broker.setQuotaBackoffMinutes(7 * 24 * 60 + 1)).toThrow(/at most 10080/);
    expect(() => broker.setQuotaBackoffMinutes(Infinity)).toThrow();
  });

  describe('quota classification through the real /api/agent stream', () => {
    const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    let scripts: unknown[][];
    let prevKey: string | undefined;
    beforeEach(() => {
      scripts = [];
      prevKey = process.env.COAGENT_API_KEY;
      process.env.COAGENT_API_KEY = 'ck_test';
      const fetchImpl = (async () => new Response(new ReadableStream({
        start(ctl) { ctl.enqueue(new TextEncoder().encode(sse(scripts.shift() ?? []))); ctl.close(); },
      }), { status: 200 })) as unknown as typeof fetch;
      const http = new HttpCloudCli({
        pluginsConfigPath: path.join(tmp, 'none.json'), localServerPath: path.join(tmp, 'none.json'), dbPath: path.join(tmp, 'none.db'), fetchImpl,
      });
      // The lead still goes through the fake (it is known to it); workers use the real SSE reader.
      const real = Object.assign(new FakeCloudCli(), { sessions: cc.sessions });
      real.send = (input, onApp, onEvent) => (input.sessionId === 'lead-app' ? cc.send(input, onApp, onEvent) : http.send(input, onApp, onEvent));
      broker = new Broker({ store, cloudcli: real, git: Git, prompts: filePrompts(PROMPTS), now: () => clock });
    });
    afterEach(() => {
      if (prevKey === undefined) delete process.env.COAGENT_API_KEY; else process.env.COAGENT_API_KEY = prevKey;
    });
    const start = { type: 'session-id', sessionId: 'app-w' };
    const text = (t: string) => ({ kind: 'text', role: 'assistant', content: t, provider: 'codex' });

    it('an unrelated tool error mentioning HTTP 429 in a turn that completes does not pause the worker', async () => {
      await startApprovedRun();
      scripts.push([start, { kind: 'error', content: 'GET https://api.example.com/v1 failed: HTTP 429 Too Many Requests', provider: 'codex' },
        text('The API rate-limits us; adding a retry.'), { kind: 'complete', exitCode: 0, success: true, provider: 'codex' }]);
      const w = await spawn('coder', 'fix the client', 'codex');
      expect(store.agent(w.id)).toMatchObject({ status: 'idle', lastError: null, resumeAt: null });
    });

    it('a mid-turn 429 followed by an unrelated terminal failure fails the worker, without pausing it', async () => {
      await startApprovedRun();
      scripts.push([start, { kind: 'error', content: 'upstream said 429 rate limit', provider: 'codex' }, text('retrying'),
        { kind: 'error', content: 'process exited unexpectedly', provider: 'codex' }, { kind: 'complete', exitCode: 1, success: false, provider: 'codex' }]);
      const w = await spawn('coder', 'fix the client', 'codex');
      expect(store.agent(w.id)).toMatchObject({ status: 'error', lastError: 'process exited unexpectedly' });
    });

    it('the terminal provider failure is classified, generic wording included', async () => {
      clock = Date.parse('2026-11-26T18:00:00Z');
      await startApprovedRun();
      scripts.push([start, text('working'), { kind: 'error', content: 'stream error: 429 Too Many Requests; rate limit reached', provider: 'codex' },
        { kind: 'complete', exitCode: 1, success: false, provider: 'codex' }]);
      const w = await spawn('coder', 'fix the client', 'codex');
      expect(store.agent(w.id)).toMatchObject({ status: 'paused', pauseReason: 'rate limit', resumeAt: '2026-11-26T18:30:00.000Z' });
    });

    it('the distinctive provider phrase pauses even without a terminal complete', async () => {
      clock = Date.parse('2026-11-26T18:00:00Z');
      await startApprovedRun();
      scripts.push([start, { kind: 'error', content: "You've hit your usage limit. Try again at 7:13 PM.", provider: 'codex' }, text('…')]);
      const w = await spawn('coder', 'fix the client', 'codex');
      expect(store.agent(w.id)).toMatchObject({ status: 'paused', pauseReason: 'usage limit' });
    });
  });
});
