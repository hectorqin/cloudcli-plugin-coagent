import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Broker, MAX_WORKERS } from '../src/broker/broker.js';
import type { CloudCli, SendInput, SendResult, SessionInfo } from '../src/broker/cloudcli.js';
import { Git } from '../src/broker/git.js';
import { filePrompts } from '../src/broker/prompts.js';
import { Store } from '../src/broker/store.js';
import type { Caller, ToolName } from '../src/shared/protocol.js';

const PROMPTS = path.resolve(__dirname, '..', 'prompts');
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/** Stand-in for CloudCLI: records turns, hands out session ids, can be told to answer 409 or fail. */
class FakeCloudCli implements CloudCli {
  sessions = new Map<string, SessionInfo>(); // by provider id
  calls: SendInput[] = [];
  next: (SendResult['status'] | 'hold')[] = [];
  /** Releases for turns started with 'hold' (a worker that keeps working until released). */
  holds: (() => void)[] = [];
  private n = 0;
  apiKeyConfigured() { return true; }
  verifyApiKey() { return true; }
  async saveApiKey() { /* not used */ }
  async send(input: SendInput, onApp?: (id: string) => void): Promise<SendResult> {
    this.calls.push(input);
    let st = this.next.shift() ?? 'ok';
    if (st === 'busy') return { status: 'busy' };
    if (st === 'hold') {
      let app0 = input.sessionId ?? null;
      if (!app0) {
        app0 = `app-${++this.n}`;
        this.sessions.set(`prov-${this.n}`, { appSessionId: app0, providerSessionId: `prov-${this.n}`, provider: input.provider, projectPath: input.projectPath });
      }
      onApp?.(app0);
      await new Promise<void>((r) => this.holds.push(r));
      return { status: 'ok', appSessionId: app0 };
    }
    st = st as SendResult['status'];
    if (st === 'error') return { status: 'error', error: 'boom' };
    let app = input.sessionId ?? null;
    if (!app) {
      app = `app-${++this.n}`;
      this.sessions.set(`prov-${this.n}`, { appSessionId: app, providerSessionId: `prov-${this.n}`, provider: input.provider, projectPath: input.projectPath });
    }
    onApp?.(app);
    return { status: 'ok', appSessionId: app };
  }
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
    expect(w.branch).toBe(`coagent/${w.id}`);
    expect(w.worktreePath).toBe(path.join(tmp, 'proj-worktrees', `coagent-${w.id}`));
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
    for (let i = 0; i < MAX_WORKERS; i++) await spawn('planner');
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
  it('commits leftovers, merges into the lead branch, removes the worktree and keeps the branch', async () => {
    await startApprovedRun();
    const w = await spawn('coder');
    fs.writeFileSync(path.join(w.worktreePath!, 'hello.txt'), 'hi\n'); // left uncommitted on purpose
    const r = await call('request_merge', { worker: w.id });
    expect(r.ok, r.text).toBe(true);
    const gate = store.gates(w.runId).find((g) => g.kind === 'merge')!;

    await broker.decideGate(gate.id, true, 'lgtm');
    await broker.settle();
    expect(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hi\n');
    expect(fs.existsSync(w.worktreePath!)).toBe(false);
    expect(sh(repo, 'branch', '--list', w.branch!)).toContain(w.branch!);
    expect(store.agent(w.id)!.status).toBe('merged');
    expect(cc.calls.at(-1)!.message).toMatch(/approved the merge[\s\S]*lgtm/);
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

  it('records the wait in the timeline', async () => {
    const run = await startApprovedRun();
    await spawnHeld();
    await wait();
    cc.holds.splice(0).forEach((x) => x());
    await broker.settle();
    await wait();
    const types = store.events(run.id).map((e) => e.type);
    expect(types.filter((t) => t === 'wait_start')).toHaveLength(1);
    expect(types.at(-1)).toBe('wait_end');
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
