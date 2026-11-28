// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from '../src/frontend/index.js';
import { NotificationDeduper, notificationCounts, NOTIFICATIONS_KEY } from '../src/frontend/notifications.js';
import type { AgentDTO, EventDTO, RunDetailDTO, StateDTO } from '../src/shared/protocol.js';

const usage = { turns: 0, totalMs: null, currentTurnMs: null, lastContextTokens: null, contextWindow: null, inputTokens: null, outputTokens: null };
const agent = (id: string, status: AgentDTO['status'], role = 'coder'): AgentDTO => ({
  id, runId: 'r', role, provider: 'codex', providerSessionId: null, appSessionId: `app-${id}`, cwd: '/repo',
  branch: null, worktreePath: null, status, task: null, result: null, lastError: status === 'error' ? 'boom' : null,
  busy: false, activity: [], usage,
});
const detail = (): RunDetailDTO => ({
  run: { id: 'r', leadAgentId: 'lead', projectPath: '/repo', status: 'active', planStatus: 'approved', createdAt: '',
    usage: { turns: 0, totalMs: null, inputTokens: null, outputTokens: null } },
  agents: [agent('lead', 'lead', 'lead')], messages: [], events: [], gates: [],
});
const state = (current: RunDetailDTO): StateDTO => ({
  setup: { apiKeyConfigured: true, registration: {}, autoRegister: true }, me: 'lead', current, runs: [],
});

afterEach(() => { unmount(); document.body.innerHTML = ''; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const gate = (id: number, runId = 'r') => ({ id, runId, kind: 'plan' as const, requestedBy: 'lead', subjectAgent: null, payload: '',
  status: 'pending' as const, comment: null, createdAt: '', snapshot: null });
const waitEnd = (id: number, data: Record<string, unknown>, runId = 'r'): EventDTO =>
  ({ id, runId, agentId: 'lead', type: 'wait_end', data, createdAt: '' });
const tab = (rpc: () => Promise<unknown>) => {
  const container = document.createElement('div');
  document.body.append(container);
  mount(container, { context: { theme: 'light', project: null, session: { id: 'lead', title: '' } },
    onContextChange: () => () => {}, rpc: vi.fn(rpc) });
  return container;
};

describe('tab attention notifications', () => {
  it('counts pending gates and paused/error agents for header badges', () => {
    const d = detail();
    d.gates.push({ id: 4, runId: 'r', kind: 'plan', requestedBy: 'lead', subjectAgent: null, payload: '', status: 'pending', comment: null, createdAt: '', snapshot: null });
    d.agents.push(agent('paused', 'paused'), agent('bad', 'error'), agent('ok', 'idle'));
    expect(notificationCounts(d)).toEqual({ pendingGates: 1, attentionAgents: 2 });
  });

  it('deduplicates new gate/agent ids and the all-finished wait edge', () => {
    const d = detail();
    d.agents.push(agent('worker', 'running'));
    const deduper = new NotificationDeduper();
    expect(deduper.next(d)).toEqual([]); // baseline does not notify for old state
    d.gates.push({ id: 7, runId: 'r', kind: 'merge', requestedBy: 'lead', subjectAgent: 'worker', payload: '', status: 'pending', comment: null, createdAt: '', snapshot: null });
    d.agents[1] = agent('worker', 'paused');
    expect(deduper.next(d).map((n) => n.key)).toEqual(['gate:7', 'agent:worker']);
    expect(deduper.next(d)).toEqual([]);
    d.agents[1] = agent('worker', 'reported');
    // A wait that ended for another reason, or with some targets unfinished, does not notify.
    d.events.push(waitEnd(10, { reason: 'urgent', agents: ['worker'], allFinished: false }));
    d.events.push(waitEnd(11, { reason: 'done', agents: ['worker'], allFinished: false }));
    expect(deduper.next(d)).toEqual([]);
    d.events.push(waitEnd(12, { reason: 'done', agents: ['worker'], allFinished: true }));
    const finished = deduper.next(d);
    expect(finished.map((n) => n.key)).toEqual(['finished:r:12']);
    expect(finished[0].body).toContain('worker');
    expect(deduper.next(d)).toEqual([]);
    d.events.push(waitEnd(20, { reason: 'done', agents: ['worker'], allFinished: true })); // a later wait notifies again
    expect(deduper.next(d).map((n) => n.key)).toEqual(['finished:r:20']);
  });

  it('re-baselines when the run changes or on reset, so switching runs does not flood', () => {
    const a = detail();
    const deduper = new NotificationDeduper();
    expect(deduper.next(a)).toEqual([]);
    const b = detail();
    b.run = { ...b.run, id: 'other' };
    b.gates.push(gate(30, 'other'));
    b.agents.push(agent('x', 'error'));
    b.events.push(waitEnd(40, { reason: 'done', agents: ['x'], allFinished: true }, 'other'));
    expect(deduper.next(b)).toEqual([]); // old state of another run is a baseline
    b.gates.push(gate(31, 'other'));
    expect(deduper.next(b).map((n) => n.key)).toEqual(['gate:31']);
    a.gates.push(gate(5));
    deduper.reset();
    expect(deduper.next(a)).toEqual([]);
  });

  it('renders both badge counts and safely handles denied permission', async () => {
    const d = detail();
    d.gates.push({ id: 4, runId: 'r', kind: 'plan', requestedBy: 'lead', subjectAgent: null, payload: '', status: 'pending', comment: null, createdAt: '', snapshot: null });
    d.agents.push(agent('paused', 'paused'), agent('bad', 'error'));
    class DeniedNotification {
      static permission: NotificationPermission = 'denied';
      static requestPermission = vi.fn(async () => 'denied' as NotificationPermission);
    }
    vi.stubGlobal('Notification', DeniedNotification);
    const container = document.createElement('div');
    document.body.append(container);
    mount(container, { context: { theme: 'light', project: null, session: { id: 'lead', title: '' } },
      onContextChange: () => () => {}, rpc: vi.fn(async () => state(d)) });
    await vi.waitFor(() => expect(container.querySelector('[data-badge="gates"]')?.textContent).toContain('1'));
    expect(container.querySelector('[data-badge="agents"]')?.textContent).toContain('2');
    const toggle = container.querySelector<HTMLInputElement>('[data-act="notifications"]')!;
    toggle.click();
    await vi.waitFor(() => expect(container.textContent).toContain('permission denied'));
    expect(localStorage.getItem(NOTIFICATIONS_KEY)).toBe('false');
    expect(DeniedNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('turns notifications off quietly when the constructor throws, and keeps refreshing', async () => {
    const d = detail();
    class ThrowingNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
      constructor() { throw new TypeError('Illegal constructor'); }
    }
    vi.stubGlobal('Notification', ThrowingNotification);
    localStorage.setItem(NOTIFICATIONS_KEY, 'true');
    let calls = 0;
    const container = tab(async () => { calls++; return state(d); });
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>('[data-act="notifications"]')?.checked).toBe(true));
    d.gates.push(gate(9));
    // The next poll sees the gate: the throwing constructor must not stop that state from being applied.
    await vi.waitFor(() => expect(container.querySelector('[data-badge="gates"]')?.textContent).toContain('1'), { timeout: 5000 });
    expect(container.querySelector<HTMLInputElement>('[data-act="notifications"]')!.checked).toBe(false);
    expect(localStorage.getItem(NOTIFICATIONS_KEY)).toBe('false');
    expect(calls).toBeGreaterThan(1);
  });

  it('unchecks the toggle when requestPermission() rejects', async () => {
    class RejectingNotification {
      static permission: NotificationPermission = 'default';
      static requestPermission = vi.fn(async (): Promise<NotificationPermission> => { throw new Error('blocked'); });
    }
    vi.stubGlobal('Notification', RejectingNotification);
    const container = tab(async () => state(detail()));
    await vi.waitFor(() => expect(container.querySelector('[data-act="notifications"]')).not.toBeNull());
    container.querySelector<HTMLInputElement>('[data-act="notifications"]')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('permission denied'));
    expect(RejectingNotification.requestPermission).toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('[data-act="notifications"]')!.checked).toBe(false);
    expect(localStorage.getItem(NOTIFICATIONS_KEY)).toBe('false');
  });
});
