import { describe, expect, it } from 'vitest';
import { buildTimeline, USER_LANE } from '../src/frontend/timeline.js';
import type { AgentDTO, RunDetailDTO } from '../src/shared/protocol.js';

const t = (s: number) => new Date(Date.UTC(2026, 10, 25, 9, 0, s)).toISOString();
const agent = (id: string, role: string, extra: Partial<AgentDTO> = {}): AgentDTO => ({
  id, runId: 'r', role, provider: 'claude', providerSessionId: null, appSessionId: null, cwd: '/x', branch: null,
  worktreePath: null, status: 'idle', task: null, result: null, lastError: null, busy: false, activity: [],
  usage: { turns: 0, totalMs: null, currentTurnMs: null, lastContextTokens: null, contextWindow: null, inputTokens: null, outputTokens: null },
  ...extra,
});

function detail(): RunDetailDTO {
  return {
    run: { id: 'r', leadAgentId: 'lead', projectPath: '/x', status: 'active', planStatus: 'approved', createdAt: t(0), usage: { turns: 0, totalMs: null, inputTokens: null, outputTokens: null } },
    agents: [agent('lead', 'lead', { status: 'lead' }), agent('coder-1', 'coder', { busy: true })],
    gates: [{ id: 1, runId: 'r', kind: 'plan', requestedBy: 'lead', subjectAgent: null, payload: 'p', status: 'approved', comment: null, createdAt: t(1), snapshot: null }],
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

  it('shows pauses, resumes and a handoff arrow from the old lane to the new one', () => {
    const d = detail();
    d.agents.push(agent('coder-2', 'coder', { provider: 'codex' }));
    d.events.push(
      { id: 8, runId: 'r', agentId: 'coder-1', type: 'paused', data: { reason: 'usage limit', resumeAt: '2026-11-26T19:14:00.000Z' }, createdAt: t(8) },
      { id: 9, runId: 'r', agentId: 'coder-1', type: 'resumed', data: { by: 'auto' }, createdAt: t(9) },
      { id: 10, runId: 'r', agentId: 'coder-1', type: 'agent_ended', data: { by: 'lead', handoff: 'coder-2' }, createdAt: t(10) },
      { id: 11, runId: 'r', agentId: 'coder-2', type: 'spawned', data: { provider: 'codex', handoffFrom: 'coder-1' }, createdAt: t(10) },
      { id: 12, runId: 'r', agentId: 'coder-1', type: 'handoff', data: { from: 'coder-1', to: 'coder-2', provider: 'codex' }, createdAt: t(10) },
    );
    const rows = buildTimeline(d).rows;
    expect(rows.find((r) => r.kind === 'node' && r.label === 'paused (usage limit) until 19:14 UTC')).toMatchObject({ lane: 2, tone: 'warn' });
    expect(rows.find((r) => r.kind === 'node' && r.label === 'auto-resumed')).toBeTruthy();
    expect(rows.find((r) => r.kind === 'node' && r.label === 'ended (handed off)')).toBeTruthy();
    expect(rows.find((r) => r.kind === 'node' && r.label === 'took over from coder-1 · codex')).toMatchObject({ lane: 3 });
    expect(rows.find((r) => r.kind === 'arrow' && r.label === 'handoff → coder-2 · codex'))
      .toMatchObject({ from: 2, to: 3, tone: 'accent', pending: false, ref: { type: 'event', id: 12 } });
  });

  it('closes a dangling bar when the agent is no longer busy', () => {
    const d = detail();
    d.agents[1].busy = false;
    expect(buildTimeline(d).bars[1].end).toBe(8);
  });
});
