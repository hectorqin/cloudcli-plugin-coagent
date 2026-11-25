/**
 * Text for turn/time/token usage, shared by the tab and the chat cards. Plain text: callers escape it.
 * Unknown values (null) always read "—", never 0. No dollar amounts: CloudCLI's numbers are not a bill (Claude's are
 * context snapshots), see src/broker/usage.ts.
 */
import type { AgentUsageDTO, RunUsageDTO } from '../shared/protocol.js';

export const UNKNOWN = '—';

export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return UNKNOWN;
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return UNKNOWN;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "ctx 45k/200k"; either side "—" when unknown. */
export function ctxText(u: Pick<AgentUsageDTO, 'lastContextTokens' | 'contextWindow'>): string {
  return `ctx ${fmtTokens(u.lastContextTokens)}/${fmtTokens(u.contextWindow)}`;
}

/** "in 12k · out 3.4k" (sums of per-turn bills; "—" when the provider reports none, e.g. Claude). */
export function tokensText(u: Pick<RunUsageDTO, 'inputTokens' | 'outputTokens'>): string {
  return `in ${fmtTokens(u.inputTokens)} · out ${fmtTokens(u.outputTokens)}`;
}

const turnsText = (n: number) => `${n} turn${n === 1 ? '' : 's'}`;

/** Compact line for a lane header: turns, total time, context use. */
export function agentUsageShort(u: AgentUsageDTO): string {
  return `${turnsText(u.turns)} · ${fmtDuration(u.totalMs)} · ${ctxText(u)}`;
}

/** Full line for the agent drawer. */
export function agentUsageLong(u: AgentUsageDTO): string {
  return `${agentUsageShort(u)} · ${tokensText(u)}`;
}

/** Run header totals. Context is per agent, so a run has none. */
export function runUsageText(u: RunUsageDTO): string {
  return `${turnsText(u.turns)} · ${fmtDuration(u.totalMs)} · ${tokensText(u)}`;
}

/** Chat card line for one worker: elapsed time of the running turn (or total time when idle) and context use. */
export function cardUsageText(u: AgentUsageDTO): string {
  const time = u.currentTurnMs !== null ? `turn ${fmtDuration(u.currentTurnMs)}` : `${turnsText(u.turns)} · ${fmtDuration(u.totalMs)}`;
  return `${time} · ${ctxText(u)}`;
}

// ── tab snippets (HTML, escaped) ──────────────────────────────────────
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Lane header line: compact, with the full line (tokens included) as a tooltip. */
export function laneUsageHtml(u: AgentUsageDTO | undefined): string {
  return u ? `<div class="sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(agentUsageLong(u))}">${esc(agentUsageShort(u))}</div>` : '';
}

/** Agent drawer line. */
export function drawerUsageHtml(u: AgentUsageDTO | undefined): string {
  return u ? `<div class="sub" data-usage>${esc(agentUsageLong(u))}</div>` : '';
}

/** Run header totals (inline). */
export function runUsageHtml(u: RunUsageDTO | undefined): string {
  return u ? ` · <span title="turns the broker ran · total turn time · summed per-turn tokens (— = not reported)">${esc(runUsageText(u))}</span>` : '';
}
