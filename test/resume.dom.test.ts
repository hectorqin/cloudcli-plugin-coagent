// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from '../src/frontend/index.js';
import { renderTool, type ToolContext } from '../src/frontend/toolCards.js';
import type { AgentDTO, StateDTO } from '../src/shared/protocol.js';

const usage = { turns: 0, totalMs: null, currentTurnMs: null, lastContextTokens: null, contextWindow: null, inputTokens: null, outputTokens: null };
const agent = (id: string, role: string, extra: Partial<AgentDTO> = {}): AgentDTO => ({
  id, runId: 'r', role, provider: 'claude', providerSessionId: null, appSessionId: `app-${id}`, cwd: '/projects/repo',
  branch: null, worktreePath: null, status: 'idle', task: null, result: null, lastError: null, busy: false, activity: [], usage, ...extra,
});
const state: StateDTO = {
  setup: { apiKeyConfigured: true, registration: {}, autoRegister: true }, me: 'lead', runs: [],
  current: {
    run: { id: 'r', leadAgentId: 'lead', projectPath: '/projects/repo', status: 'active', planStatus: 'approved', createdAt: '', usage: { turns: 0, totalMs: null, inputTokens: null, outputTokens: null } },
    agents: [
      agent('lead', 'lead', { status: 'lead' }),
      agent('coder-1', 'coder', { status: 'paused', pauseReason: 'usage limit', resumeAt: '2026-11-26T19:14:00.000Z' }),
      agent('coder-2', 'coder', { status: 'error', lastError: 'boom' }),
    ],
    messages: [], events: [], gates: [],
  },
};

afterEach(() => { unmount(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('resume controls', () => {
  it('the wait card posts Resume now / Cancel auto-resume / Resume to the tab routes', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const rpc = vi.fn(async (_m: string, p: string) => (p.startsWith('state') ? state : { ok: true, text: `done ${p}` }));
    const ctx: ToolContext = {
      toolName: 'mcp__coagent__wait_for_agents', toolId: 't', toolInput: {}, toolResult: null, status: 'running',
      theme: 'light', project: null, sessionId: 'resume-card',
    };
    const view = renderTool(el, ctx, { rpc, openSession: vi.fn() });
    await vi.waitFor(() => expect(el.querySelector('[data-resume="coder-1"]')).not.toBeNull());
    expect(el.textContent).toContain('auto-resume at 19:14 UTC');
    el.querySelector<HTMLButtonElement>('[data-resume="coder-1"]')!.click();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('POST', 'agents/coder-1/resume', {}));
    await vi.waitFor(() => expect(el.querySelector('[data-cancel-resume="coder-1"]')).not.toBeNull());
    el.querySelector<HTMLButtonElement>('[data-cancel-resume="coder-1"]')!.click();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('POST', 'agents/coder-1/cancel-resume', {}));
    el.querySelector<HTMLButtonElement>('[data-resume="coder-2"]')!.click();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('POST', 'agents/coder-2/resume', {}));
    view.destroy();
  });

  it('the tab agent drawer offers the same actions', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const rpc = vi.fn(async (_m: string, p: string) => (p.startsWith('state') ? state : { ok: true, text: 'Resumed coder-1' }));
    mount(container, { context: { theme: 'light', project: null, session: { id: 'lead-session', title: '' } }, onContextChange: () => () => {}, rpc });
    await vi.waitFor(() => expect(container.querySelector('[data-type="agent"][data-id="coder-1"]')).not.toBeNull());
    container.querySelector<HTMLElement>('[data-type="agent"][data-id="coder-1"]')!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-act="resume"]')?.textContent).toBe('Resume now'));
    expect(container.querySelector('[data-act="cancel-resume"]')).not.toBeNull();
    container.querySelector<HTMLElement>('[data-act="resume"]')!.click();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('POST', 'agents/coder-1/resume', {}));
    container.querySelector<HTMLElement>('[data-type="agent"][data-id="coder-2"]')!.click();
    await vi.waitFor(() => expect(container.querySelector('[data-act="resume"]')?.textContent).toBe('Resume'));
    expect(container.querySelector('[data-act="cancel-resume"]')).toBeNull();
  });
});
