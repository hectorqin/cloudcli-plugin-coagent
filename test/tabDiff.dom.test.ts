// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDTO, GateDTO, StateDTO } from '../src/shared/protocol.js';

const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/frontend/diffView.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/frontend/diffView.js')>();
  return { ...real, mountDiff: (...args: Parameters<typeof real.mountDiff>) => { renders.count++; return real.mountDiff(...args); } };
});
const { mount, unmount } = await import('../src/frontend/index.js');

const usage = { turns: 0, totalMs: null, currentTurnMs: null, lastContextTokens: null, contextWindow: null, inputTokens: null, outputTokens: null };
const agent = (id: string, role: string, status: AgentDTO['status']): AgentDTO => ({
  id, runId: 'r', role, provider: 'claude', providerSessionId: null, appSessionId: null, cwd: '/x', branch: null,
  worktreePath: null, status, task: null, result: null, lastError: null, busy: false, activity: [], usage,
});
const gate: GateDTO = {
  id: 8, runId: 'r', kind: 'merge', requestedBy: 'lead', subjectAgent: 'coder-1', payload: 'ready', status: 'pending', comment: null, createdAt: '',
  snapshot: { workerHead: 'abc', leadHead: 'def', mergeBase: 'aaa', diffTruncated: false,
    files: [{ path: 'a.ts', oldPath: null, status: 'M', additions: 1, deletions: 1, binary: false }] },
};
const stateWith = (workerStatus: AgentDTO['status']): StateDTO => ({
  setup: { apiKeyConfigured: true, registration: {}, autoRegister: true }, me: 'lead', runs: [],
  current: {
    run: { id: 'r', leadAgentId: 'lead', projectPath: '/x', status: 'active', planStatus: 'approved', createdAt: '', usage: { turns: 0, totalMs: null, inputTokens: null, outputTokens: null } },
    agents: [agent('lead', 'lead', 'lead'), agent('coder-1', 'coder', workerStatus)], messages: [], events: [], gates: [gate],
  },
});
const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';

afterEach(() => { unmount(); vi.useRealTimers(); });

describe('tab gate drawer', () => {
  it('keeps an opened diff mounted across state redraws (no re-render for the same gate and theme)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let state = stateWith('reported');
    const rpc = vi.fn(async (_m: string, path: string) => (path.startsWith('gates/8/diff') ? { diff: DIFF, truncated: false } : state));
    const container = document.createElement('div');
    document.body.append(container);
    mount(container, { context: { theme: 'dark', project: null, session: { id: 's', title: '' } }, onContextChange: () => () => {}, rpc });
    await vi.waitFor(() => expect(container.querySelector('[data-type="gate"][data-id="8"]')).not.toBeNull());

    container.querySelector<HTMLElement>('button[data-type="gate"][data-id="8"]')!.click();
    const details = container.querySelector<HTMLDetailsElement>('details[data-diff="8"]')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(container.querySelector('.d2h-file-wrapper')).not.toBeNull());
    expect(renders.count).toBe(1);
    const host = container.querySelector('.cad-host')!;
    // The user collapses the file.
    host.querySelector<HTMLInputElement>('.d2h-file-collapse-input')!.click();

    state = stateWith('merged'); // a state change: the tab redraws on the next poll
    vi.advanceTimersByTime(2000);
    await vi.waitFor(() => expect(container.querySelector('details[data-diff="8"]')).not.toBe(details));

    const again = container.querySelector<HTMLDetailsElement>('details[data-diff="8"]')!;
    expect(again.open).toBe(true);
    expect(again.querySelector('.cad-host')).toBe(host); // same DOM node, moved over
    expect(host.querySelector('.d2h-file-diff')!.classList.contains('d2h-d-none')).toBe(true);
    expect(renders.count).toBe(1);
    expect(rpc.mock.calls.filter(([, p]) => p.startsWith('gates/')).length).toBe(1);
  });
});
