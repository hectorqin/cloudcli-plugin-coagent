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

/**
 * Stateful edge detector for one run at a time. The first snapshot of a run is a baseline (nothing that already
 * happened notifies); afterwards each gate id, agent attention edge and finished wait is emitted at most once. Seeing
 * another run id (or reset()) starts a new baseline, so switching runs never floods.
 */
export class NotificationDeduper {
  private runId: string | null = null;
  private gates = new Set<number>();
  private agents = new Set<string>();
  /** wait_end event ids already seen: one "workers finished" notification per wait. */
  private waits = new Set<number>();

  reset() { this.runId = null; }

  next(detail: RunDetailDTO | null): NotificationIntent[] {
    if (!detail) return [];
    const pending = detail.gates.filter((g) => g.status === 'pending');
    const attention = detail.agents.filter((a) => a.status === 'paused' || a.status === 'error');
    // The broker ends a wait with reason 'done' + allFinished when every targeted worker finished (its own notion of
    // finished, idle/reported included). Keyed by that wait_end event, i.e. by wait.
    const finishedWaits = detail.events.filter((e) => e.type === 'wait_end' && e.data.reason === 'done' && e.data.allFinished === true);
    // Agents leave the set when they recover, so pausing again later notifies again.
    const attentionIds = new Set(attention.map((a) => a.id));
    if (this.runId !== detail.run.id) {
      this.runId = detail.run.id;
      this.gates = new Set(pending.map((g) => g.id));
      this.agents = attentionIds;
      this.waits = new Set(finishedWaits.map((e) => e.id));
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
      out.push({ key: `agent:${agent.id}`, title: `CoAgent worker ${agent.status}`,
        body: `${agent.id}${agent.lastError ? `: ${agent.lastError}` : ' needs attention'}`,
        target: { type: 'agent', id: agent.id } });
    }
    this.agents = attentionIds;
    for (const wait of finishedWaits) if (!this.waits.has(wait.id)) {
      this.waits.add(wait.id);
      const targets = Array.isArray(wait.data.agents) ? wait.data.agents.map(String) : [];
      out.push({ key: `finished:${detail.run.id}:${wait.id}`, title: 'CoAgent workers finished',
        body: targets.length ? `Finished while the lead waited: ${targets.join(', ')}.` : 'All targeted workers finished while the lead waited.',
        target: wait.agentId ? { type: 'agent', id: wait.agentId } : null });
    }
    return out;
  }
}

/** window.localStorage itself can throw (blocked storage, sandboxed iframe), so it is only touched inside try. */
export function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function loadNotificationOptIn(storage: Pick<Storage, 'getItem'> | null): boolean {
  try { return storage?.getItem(NOTIFICATIONS_KEY) === 'true'; } catch { return false; }
}

export function saveNotificationOptIn(storage: Pick<Storage, 'setItem'> | null, value: boolean): void {
  try { storage?.setItem(NOTIFICATIONS_KEY, String(value)); } catch { /* private/blocked storage */ }
}
