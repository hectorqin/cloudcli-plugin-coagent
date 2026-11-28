// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from '../src/frontend/index.js';
import { NotificationDeduper, notificationCounts, NOTIFICATIONS_KEY } from '../src/frontend/notifications.js';
import type { AgentDTO, RunDetailDTO, StateDTO } from '../src/shared/protocol.js';

const usage = { turns: 0, totalMs: null, currentTurnMs: null, lastContextTokens: null, contextWindow: null, inputTokens: null, outputTokens: null };
const agent = (id: string, status: AgentDTO['status'], role = 'coder'): AgentDTO => ({
  id, runId: 'r', role, provider: 'codex', providerSessionId: null, appSessionId: `app-${id}`, cwd: '/repo',
  branch: null, worktreePath: null, status, task: null, result: null, lastError: status === 'error' ? 'boom' : null,
  busy: false, activity: [], usage,
});
const detail = (): RunDetailDTO => ({
  run: { id: 'r', leadAgentId: 'lead', projectPath: '/repo', status: 'active', planStatus: 'approved', createdAt: '',
    usage: { turns: 0, totalMs: null, inputTokens: null, outputTokens: null } },
  agents: [agent('lead', 'lead', 'lead')], messages: [], events: [], gates: [], leadWaiting: false,
});
const state = (current: RunDetailDTO): StateDTO => ({
  setup: { apiKeyConfigured: true, registration: {}, autoRegister: true }, me: 'lead', current, runs: [],
});

afterEach(() => { unmount(); document.body.innerHTML = ''; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
    d.leadWaiting = true;
    expect(deduper.next(d).map((n) => n.key)).toEqual(['finished:r']);
    expect(deduper.next(d)).toEqual([]);
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
});
