import { describe, expect, it } from 'vitest';
import { controlsLocked, runPhase, runPhaseBadge } from '../src/frontend/runPhase.js';

describe('run phase in the tab', () => {
  it('an active run marked ending shows "Ending…" and locks the controls', () => {
    expect(runPhase({ status: 'active' })).toBe('active');
    expect(runPhase({ status: 'active', ending: true })).toBe('ending');
    expect(runPhase({ status: 'ended', ending: true })).toBe('ended');
    expect(controlsLocked({ status: 'active' })).toBe(false);
    expect(controlsLocked({ status: 'active', ending: true })).toBe(true);
    expect(controlsLocked({ status: 'ended' })).toBe(true);
    expect(runPhaseBadge({ status: 'active', ending: true })).toBe('<span class="badge b-ending">Ending…</span>');
    expect(runPhaseBadge({ status: 'ended' })).toBe('<span class="badge b-ended">ended</span>');
  });
});
