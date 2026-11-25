import { describe, expect, it } from 'vitest';
import { agentsFor, cardHtml, resultText, type ToolContext } from '../src/frontend/toolCards.js';
import type { AgentDTO, RunDetailDTO, StateDTO } from '../src/shared/protocol.js';

const agent = (id: string, role: string, extra: Partial<AgentDTO> = {}): AgentDTO => ({
  id, runId: 'r', role, provider: 'claude', providerSessionId: null, appSessionId: `app-${id}`, cwd: '/x', branch: null,
  worktreePath: null, status: 'idle', task: null, result: null, lastError: null, busy: false, activity: [], ...extra,
});
const run: RunDetailDTO = {
  run: { id: 'r', leadAgentId: 'lead', projectPath: '/x', status: 'active', planStatus: 'approved', createdAt: '' },
  agents: [
    agent('lead', 'lead', { status: 'lead' }),
    agent('coder-1', 'coder', { busy: true, status: 'running', activity: [{ ts: '', text: 'Edit: src/a.ts' }, { ts: '', text: 'Bash: npm test' }] }),
    agent('reviewer-2', 'reviewer', { provider: 'codex', status: 'reported', result: 'LGTM <ok>' }),
  ],
  messages: [], events: [],
  gates: [{ id: 7, runId: 'r', kind: 'plan', requestedBy: 'lead', subjectAgent: null, payload: 'p', status: 'pending', comment: null, createdAt: '' }],
};
const state = { setup: { apiKeyConfigured: true, registration: {} }, me: 'lead', current: run, runs: [] } as StateDTO;
const ctx = (toolName: string, toolInput: unknown, result: string | null, status: ToolContext['status'] = 'completed'): ToolContext => ({
  toolName: `mcp__coagent__${toolName}`, toolId: 't', toolInput, status, theme: 'dark', project: null, sessionId: 'app-lead',
  toolResult: result === null ? null : { content: [{ type: 'text', text: result }], isError: false },
});

describe('tool cards', () => {
  it('reads MCP block results', () => {
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], isError: false })).toBe('a\nb');
    expect(resultText({ content: 'plain', isError: false })).toBe('plain');
  });

  it('spawn_agent is one compact line (status + link); activity is left to the wait card', () => {
    const c = ctx('spawn_agent', { role: 'coder', task: 'do it' }, 'Spawned coder-1 (role coder, provider claude) in /x');
    expect(agentsFor(c, run).map((a) => a.id)).toEqual(['coder-1']);
    const html = cardHtml(c, state);
    expect(html).toContain('working');
    expect(html).toContain('data-open="app-coder-1"');
    expect(html).not.toContain('Bash: npm test');
  });

  it('wait_for_agents shows live activity while running', () => {
    expect(cardHtml(ctx('wait_for_agents', {}, null, 'running'), state)).toContain('Bash: npm test');
  });

  it('wait_for_agents lists the targeted workers (default: all) and escapes results', () => {
    expect(agentsFor(ctx('wait_for_agents', {}, null, 'running'), run).map((a) => a.id)).toEqual(['coder-1', 'reviewer-2']);
    expect(agentsFor(ctx('wait_for_agents', { agents: ['reviewer-2'] }, null, 'running'), run).map((a) => a.id)).toEqual(['reviewer-2']);
    const html = cardHtml(ctx('wait_for_agents', { mode: 'any' }, null, 'running'), state);
    expect(html).toContain('waiting for first result · 1 working');
    expect(html).toContain('LGTM &#60;ok&#62;');
  });

  it('submit_plan shows the pending gate and where to answer it', () => {
    const html = cardHtml(ctx('submit_plan', { plan: 'step 1' }, null, 'running'), state);
    expect(html).toContain('Plan approval');
    expect(html).toContain('pending');
    expect(html).toContain('answer the form below');
    expect(html).toContain('step 1');
  });

  it('falls back gracefully without state', () => {
    expect(cardHtml(ctx('send_message', { to: 'lead', body: 'hi' }, 'Message queued'), null)).toContain('→ lead: hi');
  });
});
