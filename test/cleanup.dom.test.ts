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

afterEach(() => { unmount(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

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
});
