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
    cc = Object.assign(new FakeCloudCli(), { sessions: cc.sessions });
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
    restart(1_000).recover();
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
    const res = restart(10 * 60_000).recover();
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

    const res = restart(10 * 60_000).recover();
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
    restart(10 * 60_000).recover();
    await broker.settle();
    expect((await call('end_agent', { worker: id })).ok).toBe(true);
    expect(store.agent(id)!.status).toBe('ended');
  });

  it('a spawned worker whose first turn was never dispatched is simply started after a restart', async () => {
    const run = await startApprovedRun();
    // Persisted but not dispatched (crash right after the spawn transaction).
    store.createAgent({ id: 'coder-aaaaaa', runId: run.id, role: 'planner', provider: 'claude', cwd: repo, status: 'starting', task: 'plan it' });
    store.addMessage(run.id, run.leadAgentId, 'coder-aaaaaa', 'message', 'plan it');
    const res = restart().recover();
    await broker.settle();
    expect(res.interrupted).toEqual([]);
    const first = cc.calls.find((c) => c.message.includes('agent id: coder-aaaaaa'))!;
    expect(first.message).toContain('plan it');
    expect(store.agent('coder-aaaaaa')!.status).toBe('idle');
  });

  it('migrates a database that only has delivered_at', () => {
    store.close();
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
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
