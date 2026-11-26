/** Where a run is in its life, for the tab: an ending run is still `active` in the database but takes no new work. */
import type { RunDTO } from '../shared/protocol.js';

export type RunPhase = 'active' | 'ending' | 'ended';

export function runPhase(run: Pick<RunDTO, 'status' | 'ending'>): RunPhase {
  if (run.status === 'ended') return 'ended';
  return run.ending ? 'ending' : 'active';
}

/** Approvals, messages, End run and End agent are disabled once a run is ending or ended. */
export function controlsLocked(run: Pick<RunDTO, 'status' | 'ending'>): boolean {
  return runPhase(run) !== 'active';
}

export function runPhaseBadge(run: Pick<RunDTO, 'status' | 'ending'>): string {
  const phase = runPhase(run);
  return `<span class="badge b-${phase}">${phase === 'ending' ? 'Ending…' : phase}</span>`;
}
