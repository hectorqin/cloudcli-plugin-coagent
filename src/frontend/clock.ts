/** "19:13 UTC" for an ISO time: the broker computes pause/resume times in UTC. */
export function utcClock(iso: unknown, unknown = 'its quota resets'): string {
  return typeof iso === 'string' && !Number.isNaN(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(11, 16)} UTC` : unknown;
}
