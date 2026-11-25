import { describe, expect, it } from 'vitest';
import { buildTimeline, USER_LANE } from '../src/frontend/timeline.js';
import type { AgentDTO, RunDetailDTO } from '../src/shared/protocol.js';

const t = (s: number) => new Date(Date.UTC(2026, 10, 25, 9, 0, s)).toISOString();
const agent = (id: string, role: string, extra: Partial<AgentDTO> = {}): AgentDTO => ({
  id, runId: 'r', role, provider: 'claude', providerSessionId: null, appSessionId: null, cwd: '/x', branch: null,
  worktreePath: null, status: 'idle', task: null, result: null, lastError: null, busy: false, activity: [], ...extra,
});

function detail(): RunDetailDTO {
  return {
    run: { id: 'r', leadAgentId: 'lead', projectPath: '/x', status: 'active', planStatus: 'approved', createdAt: t(0) },
    agents: [agent('lead', 'lead', { status: 'lead' }), agent('coder-1', 'coder', { busy: true })],
    gates: [{ id: 1, runId: 'r', kind: 'plan', requestedBy: 'lead', subjectAgent: null, payload: 'p', status: 'approved', comment: null, createdAt: t(1) }],
    events: [
      { id: 1, runId: 'r', agentId: 'lead', type: 'run_started', data: {}, createdAt: t(0) },
      { id: 2, runId: 'r', agentId: 'lead', type: 'gate_opened', data: { gate: 1, kind: 'plan' }, createdAt: t(1) },
      { id: 3, runId: 'r', agentId: null, type: 'gate_decided', data: { gate: 1, status: 'approved' }, createdAt: t(2) },
      { id: 4, runId: 'r', agentId: 'lead', type: 'turn_start', data: {}, createdAt: t(3) },
      { id: 5, runId: 'r', agentId: 'coder-1', type: 'spawned', data: { provider: 'claude' }, createdAt: t(4) },
      { id: 6, runId: 'r', agentId: 'lead', type: 'turn_end', data: { ok: true }, createdAt: t(5) },
      { id: 7, runId: 'r', agentId: 'coder-1', type: 'turn_start', data: {}, createdAt: t(6) },
    ],
    messages: [
      { id: 1, runId: 'r', from: null, to: 'lead', kind: 'gate', body: 'The user APPROVED your plan (gate #1).', createdAt: t(2), deliveredAt: t(3), state: 'delivered', attempts: 1 },
      { id: 2, runId: 'r', from: 'lead', to: 'coder-1', kind: 'message', body: '\nwrite hello\nmore', createdAt: t(4), deliveredAt: t(4), state: 'delivered', attempts: 1 },
      { id: 3, runId: 'r', from: 'coder-1', to: 'lead', kind: 'result', body: 'done', createdAt: t(7), deliveredAt: null, state: 'queued', attempts: 0 },
    ],
  };
}

describe('buildTimeline', () => {
  const tl = buildTimeline(detail());

  it('puts the user first, then agents in order', () => {
    expect(tl.lanes.map((l) => l.id)).toEqual([USER_LANE, 'lead', 'coder-1']);
  });

  it('orders rows chronologically and hides gate_decided (its message shows it)', () => {
    const labels = tl.rows.map((r) => (r.kind === 'tick' ? `tick@${r.lane}` : r.label));
    expect(labels).toEqual([
      'became lead', 'plan #1 · approved', 'plan approved', 'tick@1', 'spawned · claude', 'write hello', 'tick@1', 'tick@2', 'done',
    ]);
  });

  it('draws arrows between the right lanes and marks undelivered ones', () => {
    const result = tl.rows.find((r) => r.kind === 'arrow' && r.label === 'done');
    expect(result).toMatchObject({ from: 2, to: 1, tone: 'ok', pending: true });
    expect(tl.rows.find((r) => r.kind === 'arrow' && r.label === 'plan approved')).toMatchObject({ from: 0, to: 1, tone: 'accent' });
  });

  it('turns start/end into bars; a busy agent keeps an open bar', () => {
    expect(tl.bars).toEqual([
      { lane: 1, start: 3, end: 6, ok: true, kind: 'turn' },
      { lane: 2, start: 7, end: null, ok: true, kind: 'turn' },
    ]);
  });

  it('closes a dangling bar when the agent is no longer busy', () => {
    const d = detail();
    d.agents[1].busy = false;
    expect(buildTimeline(d).bars[1].end).toBe(8);
  });
});
