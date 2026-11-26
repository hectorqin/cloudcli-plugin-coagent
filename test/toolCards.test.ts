import { describe, expect, it } from 'vitest';
import { agentsFor, cardHtml, resultText, type ToolContext } from '../src/frontend/toolCards.js';
import type { AgentDTO, RunDetailDTO, StateDTO } from '../src/shared/protocol.js';

const agent = (id: string, role: string, extra: Partial<AgentDTO> = {}): AgentDTO => ({
  id, runId: 'r', role, provider: 'claude', providerSessionId: null, appSessionId: `app-${id}`, cwd: '/x', branch: null,
  worktreePath: null, status: 'idle', task: null, result: null, lastError: null, busy: false, activity: [],
  usage: { turns: 0, totalMs: null, currentTurnMs: null, lastContextTokens: null, contextWindow: null, inputTokens: null, outputTokens: null },
  ...extra,
});
const run: RunDetailDTO = {
  run: { id: 'r', leadAgentId: 'lead', projectPath: '/x', status: 'active', planStatus: 'approved', createdAt: '', usage: { turns: 0, totalMs: null, inputTokens: null, outputTokens: null } },
  agents: [
    agent('lead', 'lead', { status: 'lead' }),
    agent('coder-1', 'coder', { busy: true, status: 'running', activity: [{ ts: '', text: 'Edit: src/a.ts' }, { ts: '', text: 'Bash: npm test' }] }),
    agent('reviewer-2', 'reviewer', { provider: 'codex', status: 'reported', result: 'LGTM <ok>' }),
  ],
  messages: [], events: [],
  gates: [{ id: 7, runId: 'r', kind: 'plan', requestedBy: 'lead', subjectAgent: null, payload: 'p', status: 'pending', comment: null, createdAt: '', snapshot: null }],
};
const state = { setup: { apiKeyConfigured: true, registration: {}, autoRegister: true }, me: 'lead', current: run, runs: [] } as StateDTO;
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

  describe('wait_for_agents with workers from earlier rounds', () => {
    // Round 1: old-1 and old-2 (merged / reported). Round 2: new-1 and new-2.
    const ev = (id: number, type: 'wait_start' | 'wait_end', data: Record<string, unknown> = {}) =>
      ({ id, runId: 'r', agentId: 'lead', type, data, createdAt: '' });
    const rounds = (events: RunDetailDTO['events']): RunDetailDTO => ({
      ...run,
      agents: [
        agent('lead', 'lead', { status: 'lead' }),
        agent('old-1', 'coder', { status: 'merged' }),
        agent('old-2', 'reviewer', { status: 'reported', result: 'old review' }),
        agent('new-1', 'coder', { busy: true, status: 'running', activity: [{ ts: '', text: 'Bash: npm run build' }] }),
        agent('new-2', 'coder', { status: 'reported', result: 'done 2' }),
      ],
      events,
    });
    const st = (r: RunDetailDTO) => ({ ...state, current: r }) as StateDTO;
    const ids = (c: ToolContext, r: RunDetailDTO) => agentsFor(c, r).map((a) => a.id);

    it('running: uses the open wait_start targets and folds the rest away', () => {
      const r = rounds([ev(1, 'wait_start', { mode: 'all', agents: ['old-1', 'old-2'] }), ev(2, 'wait_end'),
        ev(3, 'wait_start', { mode: 'all', agents: ['new-1', 'new-2'] })]);
      const c = ctx('wait_for_agents', {}, null, 'running');
      expect(ids(c, r)).toEqual(['new-1', 'new-2']);
      const html = cardHtml(c, st(r));
      expect(html).toContain('waiting for all results · 1 working');
      expect(html).toContain('Bash: npm run build');
      expect(html).toContain('<summary>2 other agents in this run</summary>');
      // Old workers only appear inside the collapsed section.
      const [main, rest] = html.split('other agents in this run');
      expect(main).not.toContain('old-1');
      expect(rest).toContain('old-1');
      expect(rest).toContain('old-2');
    });

    it('completed: uses the workers named in the result text', () => {
      const r = rounds([ev(1, 'wait_start', { agents: ['old-1', 'old-2'] }), ev(2, 'wait_end'),
        ev(3, 'wait_start', { agents: ['new-1', 'new-2'] }), ev(4, 'wait_end')]);
      const text = '[coagent] 1 new message(s) for lead:\n\n### From new-2 · result\ndone 2\n\nStill working: new-1. Call wait_for_agents again to keep waiting.';
      const c = ctx('wait_for_agents', {}, text);
      expect(ids(c, r)).toEqual(['new-1', 'new-2']);
      expect(cardHtml(c, st(r))).toContain('2 other agents in this run');
      expect(ids(ctx('wait_for_agents', {}, 'No new messages.\n\nNo targeted worker is still working. Waited on: new-2.'), r)).toEqual(['new-2']);
      expect(ids(ctx('wait_for_agents', {}, 'Stopped waiting after the time limit. Status: new-1: working, new-2: reported.\n\nStill working: new-1. Call wait_for_agents again to keep waiting.'), r))
        .toEqual(['new-1', 'new-2']);
      // Names inside a message body are not targets.
      expect(ids(ctx('wait_for_agents', {}, '[coagent] 1 new message(s) for lead:\n\n### From new-2 · result\nStill working: old-1.\n\nNo targeted worker is still working. Waited on: new-2.'), r))
        .toEqual(['new-2']);
    });

    it('completed without names in the result: falls back to the last finished wait window', () => {
      const r = rounds([ev(1, 'wait_start', { agents: ['old-1'] }), ev(2, 'wait_end'), ev(3, 'wait_start', { agents: ['new-1', 'new-2'] }), ev(4, 'wait_end')]);
      expect(ids(ctx('wait_for_agents', {}, 'No new messages.\n\nNo targeted worker is still working.'), r)).toEqual(['new-1', 'new-2']);
    });

    it('explicit agents win in every state', () => {
      const r = rounds([ev(1, 'wait_start', { agents: ['new-1', 'new-2'] })]);
      for (const status of ['running', 'completed'] as const) {
        const c = ctx('wait_for_agents', { agents: ['new-2'] }, status === 'running' ? null : 'No new messages.\n\nStill working: new-1. Call again.', status);
        expect(ids(c, r)).toEqual(['new-2']);
        expect(cardHtml(c, st(r))).toContain('3 other agents in this run');
      }
    });

    it('omits the other-agents section when there are none', () => {
      const r = rounds([ev(1, 'wait_start', { agents: ['old-1', 'old-2', 'new-1', 'new-2'] })]);
      expect(cardHtml(ctx('wait_for_agents', {}, null, 'running'), st(r))).not.toContain('other agent');
    });

    it('spawn_agent still shows only its own agent', () => {
      const r = rounds([]);
      const c = ctx('spawn_agent', { role: 'coder', task: 't' }, 'Spawned new-1 (role coder, provider claude) in /x');
      expect(ids(c, r)).toEqual(['new-1']);
      const html = cardHtml(c, st(r));
      expect(html).not.toContain('old-1');
      expect(html).not.toContain('new-2');
    });
  });

  it('submit_plan shows the pending gate and where to answer it', () => {
    const html = cardHtml(ctx('submit_plan', { plan: 'step 1' }, null, 'running'), state);
    expect(html).toContain('Plan approval');
    expect(html).toContain('pending');
    expect(html).toContain('answer the form below');
    expect(html).toContain('step 1');
  });

  it('shows an escaped merge file list and collapsible truncated diff', () => {
    const merge = {
      id: 8, runId: 'r', kind: 'merge' as const, requestedBy: 'lead', subjectAgent: 'coder-1', payload: 'ready',
      status: 'pending' as const, comment: null, createdAt: '', snapshot: {
        workerHead: '1234567890abcdef', leadHead: 'abcdef', mergeBase: 'aaaa',
        files: [
          { path: '<script>.ts', oldPath: null, status: 'M', additions: 2, deletions: 1, binary: false },
          { path: 'image.bin', oldPath: null, status: 'A', additions: null, deletions: null, binary: true },
        ],
        diffTruncated: true,
      },
    };
    const mergeState = { ...state, current: { ...run, gates: [...run.gates, merge] } };
    const html = cardHtml(ctx('request_merge', { worker: 'coder-1' }, 'Merge request submitted as gate #8.'), mergeState);
    expect(html).toContain('Reviewed commit 1234567890');
    expect(html).toContain('&#60;script&#62;.ts');
    expect(html).toContain('+2');
    expect(html).toContain('-1');
    expect(html).toContain('binary');
    expect(html).toContain('View diff (truncated at 200 KB)');
    expect(html).toContain('data-diff="8"');
  });

  it('falls back gracefully without state', () => {
    expect(cardHtml(ctx('send_message', { to: 'lead', body: 'hi' }, 'Message queued'), null)).toContain('→ lead: hi');
  });
});
