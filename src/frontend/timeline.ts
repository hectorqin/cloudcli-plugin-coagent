/**
 * Pure layout for the swimlane timeline: turns run state into lanes, ordered rows and turn bars.
 * Rows are ordinal (one per item, oldest first), not proportional to wall time, so bursts stay readable.
 */
import type { EventDTO, MessageDTO, RunDetailDTO } from '../shared/protocol.js';
import { utcClock as clock } from './clock.js';

export const USER_LANE = '__user';

export interface Lane { id: string; label: string; sub: string }

export type Tone = 'neutral' | 'ok' | 'accent' | 'warn' | 'error' | 'muted';

export type Ref =
  | { type: 'message'; id: number }
  | { type: 'gate'; id: number }
  | { type: 'event'; id: number };

export type Row =
  | { kind: 'arrow'; ts: string; from: number; to: number; label: string; tone: Tone; pending: boolean; ref: Ref }
  | { kind: 'node'; ts: string; lane: number; label: string; tone: Tone; shape: 'dot' | 'diamond' | 'square'; ref: Ref }
  | { kind: 'tick'; ts: string; lane: number };

/** `turn`: a session working; `wait`: the lead blocked in wait_for_agents. */
export interface Bar { lane: number; start: number; end: number | null; ok: boolean; kind: 'turn' | 'wait' }

export interface Timeline { lanes: Lane[]; rows: Row[]; bars: Bar[] }

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';


export function buildTimeline(d: RunDetailDTO): Timeline {
  const lanes: Lane[] = [{ id: USER_LANE, label: 'You', sub: 'approvals & messages' }];
  for (const a of d.agents) {
    const rounds = (d.reviews ?? []).filter((r) => r.subjectWorker === a.id)
      .map((r) => `round ${r.round} · ${r.verdict ?? r.status}`).join(' · ');
    lanes.push({ id: a.id, label: a.id, sub: `${a.role} · ${a.provider}${rounds ? ` · ${rounds}` : ''}` });
  }
  const laneOf = (id: string | null) => {
    const i = lanes.findIndex((l) => l.id === (id ?? USER_LANE));
    return i < 0 ? 0 : i;
  };
  const gateById = new Map(d.gates.map((g) => [g.id, g]));

  type Entry = { ts: string; order: number; row: Row | null; ev?: EventDTO };
  const entries: Entry[] = [];

  for (const m of d.messages) entries.push({ ts: m.createdAt, order: 1, row: messageRow(m, laneOf) });

  for (const e of d.events) {
    const lane = laneOf(e.agentId);
    const ref: Ref = { type: 'event', id: e.id };
    let row: Row | null = null;
    switch (e.type) {
      case 'run_started': row = { kind: 'node', ts: e.createdAt, lane, label: 'became lead', tone: 'accent', shape: 'square', ref }; break;
      case 'run_ended': row = { kind: 'node', ts: e.createdAt, lane, label: 'ended the run', tone: 'muted', shape: 'square', ref }; break;
      case 'spawned': row = { kind: 'node', ts: e.createdAt, lane, label: e.data.handoffFrom ? `took over from ${String(e.data.handoffFrom)} · ${String(e.data.provider ?? '')}` : `spawned · ${String(e.data.provider ?? '')}`, tone: 'accent', shape: 'square', ref }; break;
      case 'gate_opened': {
        const g = gateById.get(Number(e.data.gate));
        const status = g?.status ?? 'pending';
        const what = e.data.kind === 'plan' ? `plan #${e.data.gate}` : `merge ${String(e.data.subject ?? '')} #${e.data.gate}`;
        row = {
          kind: 'node', ts: e.createdAt, lane, label: `${what} · ${status}`, shape: 'diamond',
          tone: status === 'pending' ? 'warn' : status === 'approved' ? 'ok' : 'error', ref: { type: 'gate', id: Number(e.data.gate) },
        };
        break;
      }
      case 'merge':
        row = e.data.ok
          ? { kind: 'node', ts: e.createdAt, lane, label: `merged ${String(e.data.commit ?? '').slice(0, 7)}`, tone: 'ok', shape: 'dot', ref }
          : { kind: 'node', ts: e.createdAt, lane, label: `merge failed: ${String(e.data.reason ?? '')}`, tone: 'error', shape: 'dot', ref };
        break;
      case 'agent_ended':
        row = { kind: 'node', ts: e.createdAt, lane, label: e.data.handoff ? 'ended (handed off)' : 'ended', tone: 'muted', shape: 'square', ref };
        break;
      case 'agent_reopened':
        row = { kind: 'node', ts: e.createdAt, lane, label: 'reopened for rework', tone: 'accent', shape: 'square', ref };
        break;
      case 'handoff':
        // An arrow from the old worker's lane to the worker that took over.
        row = {
          kind: 'arrow', ts: e.createdAt, from: lane, to: laneOf(String(e.data.to ?? '')), tone: 'accent', pending: false, ref,
          label: `handoff → ${String(e.data.to ?? '')} · ${String(e.data.provider ?? '')}`,
        };
        break;
      case 'paused':
        row = { kind: 'node', ts: e.createdAt, lane, label: `paused (${String(e.data.reason ?? 'limit')}) until ${clock(e.data.resumeAt, '?')}`, tone: 'warn', shape: 'dot', ref };
        break;
      case 'resumed':
        row = { kind: 'node', ts: e.createdAt, lane, label: e.data.by === 'user' ? 'resumed by you' : 'auto-resumed', tone: 'accent', shape: 'dot', ref };
        break;
      case 'resume_cancelled': row = { kind: 'node', ts: e.createdAt, lane, label: 'auto-resume cancelled', tone: 'muted', shape: 'dot', ref }; break;
      case 'workspace_archived': row = { kind: 'node', ts: e.createdAt, lane, label: 'workspace archived', tone: 'muted', shape: 'square', ref }; break;
      case 'workspace_deleted': row = { kind: 'node', ts: e.createdAt, lane, label: 'workspace deleted', tone: 'muted', shape: 'square', ref }; break;
      case 'branches_deleted': row = { kind: 'node', ts: e.createdAt, lane, label: `deleted ${Array.isArray(e.data.deleted) ? e.data.deleted.length : 0} merged branch(es)`, tone: 'muted', shape: 'square', ref }; break;
      case 'recovered': {
        const label = e.data.status === 'interrupted' ? 'interrupted (broker restart)'
          : e.data.status === 'resumed' ? 'resumed'
            : e.data.status === 'detached' ? 'still running after broker restart'
              : e.data.status === 'finished' ? 'turn finished (after restart)'
            : `re-queued ${Array.isArray(e.data.requeued) ? e.data.requeued.length : 0} message(s) after restart`;
        row = { kind: 'node', ts: e.createdAt, lane, label, tone: e.data.status === 'resumed' ? 'accent' : 'warn', shape: 'dot', ref };
        break;
      }
      case 'turn_start':
      case 'turn_end':
      case 'wait_start':
      case 'wait_end':
        row = { kind: 'tick', ts: e.createdAt, lane };
        break;
      case 'gate_decided':
        row = null; // the decision is shown by the You → lead message that carries it
        break;
    }
    entries.push({ ts: e.createdAt, order: e.type === 'turn_end' || e.type === 'wait_end' ? 2 : 0, row, ev: e });
  }

  // Stable chronological order; at equal timestamps: turn starts/nodes, then messages, then turn ends.
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.order - b.order));

  const rows: Row[] = [];
  const bars: Bar[] = [];
  const open = new Map<string, Bar>();
  for (const en of entries) {
    if (!en.row) continue;
    const idx = rows.length;
    rows.push(en.row);
    const t = en.ev?.type;
    const lane = (en.row as { lane?: number }).lane ?? -1;
    if (t === 'turn_start' || t === 'wait_start') {
      const bar: Bar = { lane, start: idx, end: null, ok: true, kind: t === 'turn_start' ? 'turn' : 'wait' };
      open.set(`${bar.kind}:${lane}`, bar);
      bars.push(bar);
    } else if (t === 'turn_end' || t === 'wait_end') {
      const key = `${t === 'turn_end' ? 'turn' : 'wait'}:${lane}`;
      const bar = open.get(key);
      if (bar) { bar.end = idx; bar.ok = en.ev!.data.ok !== false; open.delete(key); }
    }
  }
  // An unfinished bar is either still going or was lost (e.g. broker restart).
  for (const bar of open.values()) {
    const agent = d.agents.find((a) => a.id === lanes[bar.lane].id);
    if (bar.kind === 'turn' ? !agent?.busy : false) bar.end = rows.length - 1;
  }
  return { lanes, rows, bars };
}

function messageRow(m: MessageDTO, laneOf: (id: string | null) => number): Row {
  const ref: Ref = { type: 'message', id: m.id };
  if (m.kind === 'system') {
    return { kind: 'node', ts: m.createdAt, lane: laneOf(m.to), label: firstLine(m.body), tone: /fail/i.test(m.body) ? 'error' : 'muted', shape: 'dot', ref };
  }
  const tone: Tone = m.kind === 'result' ? 'ok' : m.kind === 'gate' ? (/REJECTED|FAILED/.test(m.body) ? 'error' : 'accent') : 'neutral';
  const label = m.kind === 'gate' ? gateLabel(m.body) : firstLine(m.body);
  return { kind: 'arrow', ts: m.createdAt, from: laneOf(m.from), to: laneOf(m.to), label, tone, pending: m.state ? m.state === 'queued' || m.state === 'dispatching' : !m.deliveredAt, ref };
}

function gateLabel(body: string): string {
  if (/APPROVED your plan/.test(body)) return 'plan approved';
  if (/REJECTED your plan/.test(body)) return 'plan rejected';
  if (/merge FAILED/.test(body)) return 'merge approved, but failed';
  if (/approved the merge/.test(body)) return 'merge approved';
  if (/REJECTED merging/.test(body)) return 'merge rejected';
  return firstLine(body);
}
