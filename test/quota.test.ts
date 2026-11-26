import { describe, expect, it } from 'vitest';
import { detectQuota, formatUtc, parseResetTime } from '../src/broker/quota.js';

const CODEX = "You've hit your usage limit. To get more access now, send a request to your admin or try again at 7:13 PM.";
const CLAUDE = "Claude Code returned an error result: You've hit your 5-hour limit · resets 7:10pm (UTC)";
const at = (iso: string) => Date.parse(iso);
const GRACE = 60_000;
const T = { terminal: true };

describe('quota detection', () => {
  const now = at('2026-11-26T18:00:00Z');

  it('recognizes the real Codex message and reads its reset time (no timezone: UTC)', () => {
    expect(detectQuota(CODEX, now, T)).toEqual({ reason: 'usage limit', resetAt: at('2026-11-26T19:13:00Z') + GRACE });
  });

  it('recognizes the real Claude message with an explicit (UTC)', () => {
    expect(detectQuota(CLAUDE, now, T)).toEqual({ reason: 'usage limit', resetAt: at('2026-11-26T19:10:00Z') + GRACE });
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
    expect(detectQuota("You've hit your usage limit. Upgrade to continue.", now, T)).toEqual({ reason: 'usage limit', resetAt: null });
    expect(detectQuota('usage limit reached, resets soon', now, T)).toEqual({ reason: 'usage limit', resetAt: null });
    expect(detectQuota('usage limit; try again at 25:99', now, T)).toEqual({ reason: 'usage limit', resetAt: null });
  });

  it('generic rate limits and HTTP 429', () => {
    expect(detectQuota('HTTP 429: {"error":"Too Many Requests"}', now, T)?.reason).toBe('rate limit');
    expect(detectQuota('Error: rate_limit_error', now, T)?.reason).toBe('rate limit');
    expect(detectQuota('You are being rate-limited', now, T)?.reason).toBe('rate limit');
    expect(detectQuota('insufficient_quota', now, T)?.reason).toBe('usage limit');
  });

  it('ignores ordinary failures', () => {
    for (const e of ['boom', 'died mid-turn', 'HTTP 500: internal', 'listening on port 4290', 'took 1429 ms', 'v1.429.0', 'limit the output']) {
      expect(detectQuota(e, now, T), e).toBeNull();
    }
  });

  it('generic wording only counts for the run\'s terminal failure; provider phrases always do', () => {
    const tool = { terminal: false };
    for (const e of ['HTTP 429: Too Many Requests', 'GET https://api.example.com → 429', 'rate limit exceeded by upstream', 'usage limit of the API']) {
      expect(detectQuota(e, now, tool), e).toBeNull();
      expect(detectQuota(e, now, T), e).not.toBeNull();
    }
    expect(detectQuota(CODEX, now, tool)?.reason).toBe('usage limit');
    expect(detectQuota(CLAUDE, now, tool)?.reason).toBe('usage limit');
    expect(detectQuota('{"code":"insufficient_quota"}', now, tool)?.reason).toBe('usage limit');
  });

  it('caps reset times: absurd or non-finite values count as unreadable (configured backoff)', () => {
    expect(parseResetTime('retry in 999999 hours', now)).toBeNull();
    expect(parseResetTime(`retry in ${'9'.repeat(400)} hours`, now)).toBeNull(); // Infinity
    expect(parseResetTime('try again in 8 days 1 hours', now)).toBeNull();
    expect(parseResetTime('retry in 167 hours', now)).toBe(now + 167 * 3_600_000 + GRACE); // within 7 days
    expect(detectQuota("You've hit your usage limit. Try again in 999999 hours.", now, T)).toEqual({ reason: 'usage limit', resetAt: null });
  });

  it('IANA zones use the offset of the target date across DST changes', () => {
    // Europe/Paris springs forward on 2026-03-29 (01:00 UTC: +1 → +2) and falls back on 2026-10-25 (01:00 UTC: +2 → +1).
    expect(parseResetTime('resets 7:10pm (Europe/Paris)', at('2026-03-28T20:00:00Z'))).toBe(at('2026-03-29T17:10:00Z') + GRACE);
    expect(parseResetTime('resets 7:10pm (Europe/Paris)', at('2026-10-24T19:00:00Z'))).toBe(at('2026-10-25T18:10:00Z') + GRACE);
    // Same day, later than the switch: 03:30 CEST, not CET.
    expect(parseResetTime('resets at 3:30am (Europe/Paris)', at('2026-03-29T00:30:00Z'))).toBe(at('2026-03-29T01:30:00Z') + GRACE);
    expect(parseResetTime('resets at 3:30am (Europe/Paris)', at('2026-10-25T00:30:00Z'))).toBe(at('2026-10-25T02:30:00Z') + GRACE);
    expect(parseResetTime('resets 7:10pm (Mars/Olympus)', now)).toBeNull();
  });

  it('formats times as UTC', () => {
    expect(formatUtc(at('2026-11-26T19:14:00Z'))).toBe('2026-11-26 19:14 UTC');
  });
});
