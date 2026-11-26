// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from '../src/frontend/index.js';
import { renderTool, type ToolContext, type ToolHost } from '../src/frontend/toolCards.js';
import type { AgentDTO, StateDTO } from '../src/shared/protocol.js';

const usage = { turns: 0, totalMs: null, currentTurnMs: null, lastContextTokens: null, contextWindow: null, inputTokens: null, outputTokens: null };
const agent = (id: string, role: string, extra: Partial<AgentDTO> = {}): AgentDTO => ({
  id, runId: 'r', role, provider: 'claude', providerSessionId: null, appSessionId: `app-${id}`, cwd: `/projects/repo-worktrees/${id}`,
  branch: null, worktreePath: null, status: 'idle', task: null, result: null, lastError: null, busy: false, activity: [], usage, ...extra,
});
const writer = agent('coder-1', 'coder', { branch: 'coagent/r/coder-1', status: 'merged' });
const reviewer = agent('reviewer-1', 'reviewer', { cwd: '/projects/repo', status: 'reported' });
const state: StateDTO = {
  setup: { apiKeyConfigured: true, registration: {}, autoRegister: true }, me: 'lead', runs: [],
  current: {
    run: { id: 'r', leadAgentId: 'lead', projectPath: '/projects/repo', status: 'active', planStatus: 'approved', createdAt: '', usage: { turns: 0, totalMs: null, inputTokens: null, outputTokens: null } },
    agents: [agent('lead', 'lead', { cwd: '/projects/repo', status: 'lead' }), writer, reviewer], messages: [],
    events: [{ id: 1, runId: 'r', agentId: 'lead', type: 'gate_opened', data: { gate: 8, kind: 'merge', subject: writer.id }, createdAt: '2026-01-01T00:00:00Z' }],
    gates: [{ id: 8, runId: 'r', kind: 'merge', requestedBy: 'lead', subjectAgent: writer.id, payload: 'ready', status: 'approved', comment: null, createdAt: '', snapshot: null }],
  },
};
const context: ToolContext = {
  toolName: 'mcp__coagent__request_merge', toolId: 't', toolInput: { worker: writer.id },
  toolResult: { content: 'Merge request submitted as gate #8.', isError: false }, status: 'completed', theme: 'light', project: null, sessionId: 'card-session',
};

afterEach(() => { unmount(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('workspace cleanup controls', () => {
  it('merge cards feature-detect host cleanup, show the vanilla-host hint, and invoke archive without blocking', async () => {
    const bare = document.createElement('div');
    document.body.append(bare);
    const bareView = renderTool(bare, context, { rpc: vi.fn(async () => state), openSession: vi.fn() });
    await vi.waitFor(() => expect(bare.textContent).toContain('Archive it from the sidebar (the project is under repo → worktrees)'));
    expect(bare.textContent).not.toContain('Archive worker session');
    bareView.destroy();

    const rich = document.createElement('div');
    document.body.append(rich);
    const archiveProject = vi.fn(async () => ({ ok: true as const }));
    const rpc = vi.fn(async (method: string, path: string) => path.startsWith('state') ? state : { ok: true });
    const host: ToolHost = { rpc, openSession: vi.fn(), archiveProject, deleteProject: vi.fn(async () => undefined) };
    const view = renderTool(rich, { ...context, sessionId: 'card-session-rich' }, host);
    await vi.waitFor(() => expect(rich.textContent).toContain('Archive worker session'));
    expect(rich.textContent).toContain('Delete');
    rich.querySelector<HTMLButtonElement>('[data-clean="archive"]')!.click();
    await vi.waitFor(() => expect(archiveProject).toHaveBeenCalledWith(writer.cwd));
    expect(rpc).toHaveBeenCalledWith('POST', 'runs/r/workspaces/event', { agentId: writer.id, type: 'workspace_archived' });
    view.destroy();
  });

  it('the tab shows cleanup after merge for writers only, including the gate drawer', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const api = { context: { theme: 'light' as const, project: null, session: { id: 'lead-session', title: '' } },
      onContextChange: () => () => {}, rpc: vi.fn(async () => state) };
    mount(container, api);
    await vi.waitFor(() => expect(container.querySelector('[data-type="agent"][data-id="coder-1"]')).not.toBeNull());
    container.querySelector<HTMLElement>('[data-type="agent"][data-id="coder-1"]')!.click();
    expect(container.textContent).toContain('Archive it from the sidebar (the project is under repo → worktrees)');
    container.querySelector<HTMLElement>('[data-type="agent"][data-id="reviewer-1"]')!.click();
    expect(container.textContent).not.toContain('Archive worker session');
    expect(container.textContent).not.toContain('Archive it from the sidebar');
    container.querySelector<HTMLElement>('[data-type="gate"][data-id="8"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container.textContent).toContain('Archive it from the sidebar (the project is under repo → worktrees)');
  });

  it('an enhanced tab exposes archive/delete buttons only for the merged writer', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    mount(container, { context: { theme: 'light', project: null, session: { id: 'lead-session', title: '' } }, onContextChange: () => () => {},
      rpc: vi.fn(async () => state), archiveProject: vi.fn(async () => ({ ok: true as const })), deleteProject: vi.fn(async () => undefined) });
    await vi.waitFor(() => expect(container.querySelector('[data-type="agent"][data-id="coder-1"]')).not.toBeNull());
    container.querySelector<HTMLElement>('[data-type="agent"][data-id="coder-1"]')!.click();
    expect(container.textContent).toContain('Archive worker session');
    expect(container.textContent).toContain('Delete');
  });

  it('guards unsafe paths before any host call', async () => {
    const unsafe = structuredClone(state);
    unsafe.current!.agents.find((a) => a.id === writer.id)!.cwd = '/projects/repo';
    const archiveProject = vi.fn(async () => ({ ok: true as const }));
    const container = document.createElement('div');
    document.body.append(container);
    const view = renderTool(container, { ...context, sessionId: 'unsafe-card' }, {
      rpc: vi.fn(async () => unsafe), openSession: vi.fn(), archiveProject, deleteProject: vi.fn(async () => undefined),
    });
    await vi.waitFor(() => expect(container.textContent).toContain('Merge approval'));
    expect(container.textContent).not.toContain('Archive worker session');
    expect(container.textContent).not.toContain('Archive it from the sidebar');
    expect(archiveProject).not.toHaveBeenCalled();
    view.destroy();
  });

  it('keeps one host call in flight, survives redraws, and does not let event RPC failure erase success', async () => {
    let release!: (value: { ok: true }) => void;
    const pending = new Promise<{ ok: true }>((resolve) => { release = resolve; });
    const archiveProject = vi.fn(() => pending);
    const rpc = vi.fn((method: string, path: string) => path.startsWith('state') ? Promise.resolve(state) : Promise.reject(new Error('event unavailable')));
    const container = document.createElement('div');
    document.body.append(container);
    const view = renderTool(container, { ...context, sessionId: 'pending-card' }, { rpc, openSession: vi.fn(), archiveProject });
    await vi.waitFor(() => expect(container.querySelector('[data-clean="archive"]')).not.toBeNull());
    const button = container.querySelector<HTMLButtonElement>('[data-clean="archive"]')!;
    button.click();
    button.click();
    view.update({ ...context, sessionId: 'pending-card' });
    await Promise.resolve();
    expect(archiveProject).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('[data-clean="archive"]')!.disabled).toBe(true);
    release({ ok: true });
    await vi.waitFor(() => expect(container.textContent).toContain('Archived'));
    expect(container.textContent).not.toContain('event unavailable');
    expect(container.querySelector('[data-clean]')).toBeNull();
    view.destroy();
  });

  it('shows host-declared and rejected errors while leaving cleanup retryable', async () => {
    for (const [sessionId, archiveProject, message] of [
      ['false-card', vi.fn(async () => ({ ok: false as const, error: 'not a worktree' })), 'not a worktree'],
      ['reject-card', vi.fn(async () => { throw new Error('host offline'); }), 'host offline'],
      ['throw-card', vi.fn(() => { throw new Error('sync failure'); }), 'sync failure'],
    ] as const) {
      const container = document.createElement('div');
      document.body.append(container);
      const view = renderTool(container, { ...context, sessionId }, { rpc: vi.fn(async () => state), openSession: vi.fn(), archiveProject });
      await vi.waitFor(() => expect(container.querySelector('[data-clean="archive"]')).not.toBeNull());
      container.querySelector<HTMLButtonElement>('[data-clean="archive"]')!.click();
      await vi.waitFor(() => expect(container.textContent).toContain(`Error: ${message}`));
      expect(container.querySelector('[data-clean="archive"]')).not.toBeNull();
      view.destroy();
      container.remove();
    }
  });

  it('confirms delete with worker identity/path and archives all writers with a readable top summary', async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    const deleteProject = vi.fn(async () => ({ ok: true }));
    const card = document.createElement('div');
    document.body.append(card);
    const cardView = renderTool(card, { ...context, sessionId: 'delete-card' }, {
      rpc: vi.fn(async (_method, path) => path.startsWith('state') ? state : { ok: true }), openSession: vi.fn(), deleteProject,
    });
    await vi.waitFor(() => expect(card.querySelector('[data-clean="delete"]')).not.toBeNull());
    card.querySelector<HTMLButtonElement>('[data-clean="delete"]')!.click();
    expect(confirmSpy).toHaveBeenCalledWith(`Delete worker project ${writer.id} (${writer.cwd})? Its sessions and transcripts will be permanently removed.`);
    await vi.waitFor(() => expect(deleteProject).toHaveBeenCalledWith(writer.cwd));
    cardView.destroy();

    const ended = structuredClone(state);
    ended.current!.run.status = 'ended';
    const archiveProject = vi.fn(async () => ({ ok: true as const }));
    const tab = document.createElement('div');
    document.body.append(tab);
    mount(tab, { context: { theme: 'light', project: null, session: { id: 'lead-session', title: '' } }, onContextChange: () => () => {},
      rpc: vi.fn(async (_method, path) => path.startsWith('state') ? ended : path.includes('delete-merged')
        ? { deleted: [], skipped: [{ branch: 'coagent/r/coder-1', reason: 'checked out elsewhere' }] } : { ok: true }), archiveProject, deleteProject });
    await vi.waitFor(() => expect(tab.textContent).toContain('Archive all worker sessions'));
    tab.querySelector<HTMLButtonElement>('[data-act="archive-all"]')!.click();
    await vi.waitFor(() => expect(tab.textContent).toContain('Archive all: 1 archived.'));
    expect(archiveProject).toHaveBeenCalledTimes(1);
    expect(archiveProject).toHaveBeenCalledWith(writer.cwd);
    expect(tab.querySelector('[data-act="archive-all"]')).toBeNull();
    tab.querySelector<HTMLButtonElement>('[data-act="delete-branches"]')!.click();
    await vi.waitFor(() => expect(tab.textContent).toContain('deleted 0; skipped: coagent/r/coder-1 — checked out elsewhere'));
  });

  it('uses an inline end-run options panel instead of chained confirms', async () => {
    const confirmSpy = vi.fn();
    vi.stubGlobal('confirm', confirmSpy);
    const container = document.createElement('div');
    document.body.append(container);
    mount(container, { context: { theme: 'light', project: null, session: { id: 'lead-session', title: '' } }, onContextChange: () => () => {},
      rpc: vi.fn(async () => state), archiveProject: vi.fn(async () => ({ ok: true as const })) });
    await vi.waitFor(() => expect(container.querySelector('[data-act="end"]')).not.toBeNull());
    container.querySelector<HTMLButtonElement>('[data-act="end"]')!.click();
    expect(container.textContent).toContain('Choose cleanup to run after the collaboration ends.');
    expect(container.querySelector('[data-end-option="archive"]')).not.toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();

    unmount();
    const noWriters = structuredClone(state);
    noWriters.current!.agents = noWriters.current!.agents.filter((a) => a.role === 'lead' || a.role === 'reviewer');
    noWriters.current!.gates = [];
    noWriters.current!.events = [];
    const empty = document.createElement('div');
    document.body.append(empty);
    mount(empty, { context: { theme: 'light', project: null, session: { id: 'lead-session', title: '' } }, onContextChange: () => () => {},
      rpc: vi.fn(async () => noWriters), archiveProject: vi.fn(async () => ({ ok: true as const })) });
    await vi.waitFor(() => expect(empty.querySelector('[data-act="end"]')).not.toBeNull());
    empty.querySelector<HTMLButtonElement>('[data-act="end"]')!.click();
    expect(empty.querySelector('[data-end-option="archive"]')).toBeNull();
    expect(empty.querySelector('[data-end-option="branches"]')).toBeNull();
    expect(empty.querySelector('[data-act="delete-branches"]')).toBeNull();
  });
});
