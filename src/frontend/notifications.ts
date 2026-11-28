import type { RunDetailDTO } from '../shared/protocol.js';

export const NOTIFICATIONS_KEY = 'coagent.browserNotifications';

export interface NotificationCounts { pendingGates: number; attentionAgents: number }
export type NotificationTarget = { type: 'gate'; id: number } | { type: 'agent'; id: string } | null;
export interface NotificationIntent { key: string; title: string; body: string; target: NotificationTarget }

export function notificationCounts(detail: RunDetailDTO | null): NotificationCounts {
  return {
    pendingGates: detail?.gates.filter((g) => g.status === 'pending').length ?? 0,
    attentionAgents: detail?.agents.filter((a) => a.status === 'paused' || a.status === 'error').length ?? 0,
  };
}

const FINISHED = new Set(['reported', 'merged', 'ended', 'error', 'interrupted']);

/** Stateful edge detector: the first snapshot is a baseline, then each gate/agent id is emitted at most once. */
export class NotificationDeduper {
  private primed = false;
  private gates = new Set<number>();
  private agents = new Set<string>();
  private finished = false;

  next(detail: RunDetailDTO | null): NotificationIntent[] {
    if (!detail) return [];
    const pending = detail.gates.filter((g) => g.status === 'pending');
    const attention = detail.agents.filter((a) => a.status === 'paused' || a.status === 'error');
    const workers = detail.agents.filter((a) => a.role !== 'lead');
    if (!this.primed) {
      pending.forEach((g) => this.gates.add(g.id));
      attention.forEach((a) => this.agents.add(a.id));
      this.primed = true;
      return [];
    }
    const out: NotificationIntent[] = [];
    for (const gate of pending) if (!this.gates.has(gate.id)) {
      this.gates.add(gate.id);
      out.push({ key: `gate:${gate.id}`, title: 'CoAgent needs your approval',
        body: gate.kind === 'plan' ? `Plan #${gate.id} is waiting` : `Merge for ${gate.subjectAgent ?? 'a worker'} is waiting`,
        target: { type: 'gate', id: gate.id } });
    }
    for (const agent of attention) if (!this.agents.has(agent.id)) {
      this.agents.add(agent.id);
      out.push({ key: `agent:${agent.id}`, title: `CoAgent worker ${agent.status}`,
        body: `${agent.id}${agent.lastError ? `: ${agent.lastError}` : ' needs attention'}`,
        target: { type: 'agent', id: agent.id } });
    }
    const allFinishedWhileWaiting = !!detail.leadWaiting && workers.length > 0 && workers.every((a) => FINISHED.has(a.status));
    if (allFinishedWhileWaiting && !this.finished) {
      this.finished = true;
      out.push({ key: `finished:${detail.run.id}`, title: 'CoAgent workers finished',
        body: 'All targeted workers finished while the lead is waiting.', target: null });
    }
    if (!detail.leadWaiting) this.finished = false;
    return out;
  }
}

export function loadNotificationOptIn(storage: Pick<Storage, 'getItem'>): boolean {
  try { return storage.getItem(NOTIFICATIONS_KEY) === 'true'; } catch { return false; }
}

export function saveNotificationOptIn(storage: Pick<Storage, 'setItem'>, value: boolean): void {
  try { storage.setItem(NOTIFICATIONS_KEY, String(value)); } catch { /* private/blocked storage */ }
}
