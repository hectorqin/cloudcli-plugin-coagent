/**
 * Recognizes provider quota / rate-limit failures in a turn's error text, and when the quota resets.
 * Real messages this was written against:
 *   Codex:  "You've hit your usage limit. To get more access now, send a request to your admin or try again at 7:13 PM."
 *   Claude: "Claude Code returned an error result: You've hit your 5-hour limit · resets 7:10pm (UTC)"
 */

export const DEFAULT_QUOTA_BACKOFF_MINUTES = 30;
/** No pause lasts longer than this: a parsed reset further away (or garbage) falls back to the configured backoff. */
export const MAX_PAUSE_MS = 7 * 24 * 3_600_000;
export const MAX_QUOTA_BACKOFF_MINUTES = MAX_PAUSE_MS / 60_000;
/** Resume a little after the announced reset, so the provider has really reset the counter. */
const RESET_GRACE_MS = 60_000;

export interface QuotaHit {
  /** Short reason for the lead and the timeline: "usage limit" or "rate limit". */
  reason: string;
  /** Epoch ms when the quota resets, or null when the text gives no time we can read. */
  resetAt: number | null;
}

/**
 * Phrases only providers use about the account's own quota: they count wherever the error came from.
 * Everything else below is generic wording that a tool or an external API can produce too (an agent debugging an HTTP
 * 429 of some service), so it only counts for the run's terminal failure (see SendResult.terminal).
 */
const PROVIDER_USAGE_PATTERNS = [
  /\bhit your (?:[\w-]+ )*limit\b/i, // "You've hit your usage limit", "hit your 5-hour limit", "hit your weekly limit"
  /\b\d+-hour limit\b/i,
  /\binsufficient_quota\b/i,
];
const GENERIC_USAGE_PATTERNS = [
  /\busage limit\b/i,
  /\bquota (?:exceeded|exhausted|reached)\b/i,
  /\bexceeded (?:your |the )?(?:current )?quota\b/i,
  /\bout of (?:credits|quota)\b/i,
];
const GENERIC_RATE_PATTERNS = [
  /(?:^|[^a-z])rate[ _-]?limit/i, // rate limit, rate-limited, rate_limit_error
  /\btoo many requests\b/i,
  /(?:^|[^\d.:])429(?:[^\d.:]|$)/, // HTTP 429, not part of a larger number, version or time
];

/**
 * null when the error is not about quota or rate limits. `now` anchors the reset time to the next occurrence.
 * `terminal`: the text is the run's own terminal failure (provider or transport), not some intermediate error event;
 * only then do generic signatures ("rate limit", "429", "too many requests", "usage limit") count.
 */
export function detectQuota(error: string, now: number, opts: { terminal: boolean }): QuotaHit | null {
  const text = error ?? '';
  const usage = PROVIDER_USAGE_PATTERNS.some((p) => p.test(text)) || (opts.terminal && GENERIC_USAGE_PATTERNS.some((p) => p.test(text)));
  if (!usage && !(opts.terminal && GENERIC_RATE_PATTERNS.some((p) => p.test(text)))) return null;
  return { reason: usage ? 'usage limit' : 'rate limit', resetAt: parseResetTime(text, now) };
}

const ZONE_OFFSETS: Record<string, number> = { UTC: 0, GMT: 0, Z: 0 };

/**
 * The reset time a quota message announces, as epoch ms strictly after `now` (plus a small grace), or null.
 * Understands "try again at 7:13 PM", "resets 7:10pm (UTC)", "resets at 19:10 GMT+2", "reset at 7pm (Europe/Paris)"
 * and relative forms ("try again in 20 minutes", "in 2h 5m").
 * A clock time with no timezone is taken as UTC: the broker cannot know which zone the provider formatted it in, and
 * CloudCLI usually runs on UTC servers. If that guess is early, the resumed turn fails again and simply re-pauses.
 */
export function parseResetTime(text: string, now: number): number | null {
  const at = rawResetTime(text, now);
  // Anything not finite, not in the future, or further than MAX_PAUSE_MS counts as unreadable (→ configured backoff).
  return at !== null && Number.isFinite(at) && at > now && at - now <= MAX_PAUSE_MS ? at : null;
}

function rawResetTime(text: string, now: number): number | null {
  const relative = parseRelative(text);
  if (relative !== null) return now + relative + RESET_GRACE_MS;

  const m = text.match(
    /\b(?:try again|retry|resets?|available again|again)\b(?:\s+(?:at|after|on|around))?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(?\s*(UTC|GMT|Z|[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)?\b\s*([+-]\d{1,2}(?::?\d{2})?)?\s*\)?)?/i,
  );
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase().replace(/\./g, '');
  if (!m[2] && !ampm) return null; // a bare number ("resets 5") is not a time
  if (minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm === 'pm' ? 12 : 0);
  } else if (hour > 23) return null;

  const zone = m[4];
  const offsetText = m[5];
  // No timezone given: UTC (see above). Otherwise a fixed offset, or an IANA zone resolved on the target date.
  let offsetAt: (utcMs: number) => number | null = () => 0;
  if (offsetText) { const o = parseOffset(offsetText); offsetAt = () => o; }
  else if (zone && zone.toUpperCase() in ZONE_OFFSETS) { const o = ZONE_OFFSETS[zone.toUpperCase()]; offsetAt = () => o; }
  else if (zone) offsetAt = (utcMs) => zoneOffsetMinutes(zone, utcMs);

  // hh:mm on the zone's current date; if that has passed, on the next date. Each is resolved with the offset in force
  // at that wall time, so a DST change between now and the reset is honored.
  const nowOffset = offsetAt(now);
  if (nowOffset === null) return null;
  const today = new Date(now + nowOffset * 60_000);
  for (let days = 0; days <= 1; days++) {
    const at = wallTimeToUtc(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days, hour, minute, offsetAt);
    if (at === null) return null;
    if (at > now) return at + RESET_GRACE_MS;
  }
  return null;
}

/**
 * The UTC instant of a wall-clock time in a zone whose offset may depend on the date (DST), found by iterating:
 * guess with an offset, look up the offset in force at the guess, repeat until stable. In a spring-forward gap (a wall
 * time that does not exist) it ends on one side of the gap; in a fall-back overlap, on one of the two instants.
 */
function wallTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, offsetAt: (utcMs: number) => number | null): number | null {
  const wall = Date.UTC(y, mo, d, h, mi); // normalizes d past the month end
  let guess = wall;
  for (let i = 0; i < 4; i++) {
    const off = offsetAt(guess);
    if (off === null) return null;
    const next = wall - off * 60_000;
    if (next === guess) return guess;
    guess = next;
  }
  return guess;
}

function parseRelative(text: string): number | null {
  const m = text.match(/\b(?:try again|retry|resets?|again)\s+in\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i);
  if (!m) return null;
  let ms = 0;
  for (const part of m[1].matchAll(/(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
    const n = Number(part[1]);
    const unit = part[2].toLowerCase();
    ms += unit.startsWith('h') ? n * 3_600_000 : unit.startsWith('m') ? n * 60_000 : n * 1000;
  }
  return ms > 0 ? ms : null;
}

function parseOffset(s: string): number | null {
  const m = s.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const v = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return v > 14 * 60 ? null : (m[1] === '-' ? -v : v);
}

/** Offset of an IANA zone from UTC at `now`, in minutes; null for an unknown zone. */
function zoneOffsetMinutes(zone: string, now: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(now));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    return Math.round((local - Math.floor(now / 60_000) * 60_000) / 60_000);
  } catch {
    return null;
  }
}

/** "2026-11-26 19:13 UTC" */
export function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
