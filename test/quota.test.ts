import { describe, expect, it } from 'vitest';
import { detectQuota, formatUtc, parseResetTime } from '../src/broker/quota.js';

const CODEX = "You've hit your usage limit. To get more access now, send a request to your admin or try again at 7:13 PM.";
const CLAUDE = "Claude Code returned an error result: You've hit your 5-hour limit · resets 7:10pm (UTC)";
const at = (iso: string) => Date.parse(iso);
const GRACE = 60_000;

describe('quota detection', () => {
  const now = at('2026-11-26T18:00:00Z');

  it('recognizes the real Codex message and reads its reset time (no timezone: UTC)', () => {
    expect(detectQuota(CODEX, now)).toEqual({ reason: 'usage limit', resetAt: at('2026-11-26T19:13:00Z') + GRACE });
  });

  it('recognizes the real Claude message with an explicit (UTC)', () => {
    expect(detectQuota(CLAUDE, now)).toEqual({ reason: 'usage limit', resetAt: at('2026-11-26T19:10:00Z') + GRACE });
  });

  it('a time without a timezone that already passed today means tomorrow (UTC)', () => {
    expect(parseResetTime('try again at 7:13 PM', at('2026-11-26T20:00:00Z'))).toBe(at('2026-11-27T19:13:00Z') + GRACE);
    expect(parseResetTime('resets at 07:05', at('2026-11-26T08:00:00Z'))).toBe(at('2026-11-27T07:05:00Z') + GRACE);
    expect(parseResetTime('resets 12am', now)).toBe(at('2026-11-27T00:00:00Z') + GRACE);
  });

  it('honors explicit offsets and IANA zones', () => {
    expect(parseResetTime('resets 7:10pm (GMT+2)', now)).toBe(at('2026-11-27T17:10:00Z') + GRACE);
    expect(parseResetTime('resets 7:10pm (Europe/Paris)', now)).toBe(at('2026-11-26T18:10:00Z') + GRACE);
  });

  it('reads relative waits', () => {
    expect(parseResetTime('Rate limited. Try again in 20 minutes.', now)).toBe(now + 20 * 60_000 + GRACE);
    expect(parseResetTime('retry in 1h 5m', now)).toBe(now + 65 * 60_000 + GRACE);
  });

  it('unparseable reset text still counts as a quota error, with no time', () => {
    expect(detectQuota("You've hit your usage limit. Upgrade to continue.", now)).toEqual({ reason: 'usage limit', resetAt: null });
    expect(detectQuota('usage limit reached, resets soon', now)).toEqual({ reason: 'usage limit', resetAt: null });
    expect(detectQuota('usage limit; try again at 25:99', now)).toEqual({ reason: 'usage limit', resetAt: null });
  });

  it('generic rate limits and HTTP 429', () => {
    expect(detectQuota('HTTP 429: {"error":"Too Many Requests"}', now)?.reason).toBe('rate limit');
    expect(detectQuota('Error: rate_limit_error', now)?.reason).toBe('rate limit');
    expect(detectQuota('You are being rate-limited', now)?.reason).toBe('rate limit');
    expect(detectQuota('insufficient_quota', now)?.reason).toBe('usage limit');
  });

  it('ignores ordinary failures', () => {
    for (const e of ['boom', 'died mid-turn', 'HTTP 500: internal', 'listening on port 4290', 'took 1429 ms', 'v1.429.0', 'limit the output']) {
      expect(detectQuota(e, now), e).toBeNull();
    }
  });

  it('formats times as UTC', () => {
    expect(formatUtc(at('2026-11-26T19:14:00Z'))).toBe('2026-11-26 19:14 UTC');
  });
});
