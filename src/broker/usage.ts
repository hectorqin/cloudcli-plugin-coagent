/**
 * Token usage carried by CloudCLI's /api/agent SSE stream, and what each number means.
 *
 * Verified against the installed CloudCLI v1.37.10 (`/usr/lib/node_modules/@cloudcli-ai/cloudcli/server`):
 *
 * Wire shape. Every runtime event reaches the SSE response through the run's gateway writer as `data: <JSON>`
 * (modules/agent/agent.routes.ts:515-540). Usage arrives as a normalized status event
 *   { kind: 'status', text: 'token_budget', provider: 'claude' | 'codex', sessionId, tokenBudget: {...} }
 * built by createNormalizedMessage (shared/utils.ts:509). There is no separate `tokens` field on stream events;
 * agent.routes.ts:599-614 (`getTotalTokens`, non-streaming responses only) also just reads the LAST token_budget.
 *
 * Claude (modules/providers/list/claude/claude-runtime.provider.ts):
 *  - Emitted once per main-thread assistant message (:1714-1730, `extractTokenBudget` :732-759; subagent traffic is
 *    skipped). Each one describes that ONE request, built by `buildTokenBudget` (:698-723):
 *      inputTokens = input_tokens + cache_read + cache_creation  (the whole prompt = what the context holds)
 *      outputTokens, cacheReadTokens, cacheCreationTokens         (of that request)
 *      used  = inputTokens + outputTokens                          → context-window occupancy SNAPSHOT
 *      total = context window: SDK-reported for the model, else env CONTEXT_WINDOW, else 160000 (:651-656)
 *  - So the values are a snapshot, NOT per-turn and NOT cumulative usage: summing them across messages or turns
 *    double-counts the conversation. Only for SDK builds with no per-assistant usage does it fall back once to the
 *    turn's `result.usage` bill (`extractCumulativeTokenBudget` :778, used at :1715); that case is indistinguishable on the wire and treated the same.
 *    KNOWN LIMITATION: on such builds the last event of a turn is that cumulative bill (every request of the turn,
 *    subagents included), so the recorded context occupancy can be several times too high. coagent cannot detect
 *    this; the UI labels context use as approximate.
 *
 * Codex (modules/providers/list/codex/codex-runtime.provider.ts):
 *  - Emitted once per turn, on the SDK's `turn.completed` (:448-453), via `extractCodexTokenBudget` (:58-79).
 *    The SDK event is `{ type: 'turn.completed', usage: { input_tokens, cached_input_tokens,
 *    cache_write_input_tokens, output_tokens, reasoning_output_tokens } }`, documented as "the usage of tokens
 *    during a turn" (node_modules/@openai/codex-sdk 0.166.0 dist/index.d.ts:119-136). It carries no `info`, no
 *    `total_token_usage` and no `model_context_window`, so CloudCLI forwards:
 *      inputTokens / outputTokens = that turn's usage  → PER-TURN, safe to sum across turns
 *      used  = total_tokens || inputTokens + outputTokens → a per-turn total, NOT context occupancy
 *      total = model_context_window || 200000             → always the hard-coded 200000 default here
 *    Cache counts are dropped by CloudCLI (no cacheReadTokens field).
 *  - Hence for Codex the context window and its occupancy are unknown, and are recorded as null.
 */
import type { Provider } from '../shared/protocol.js';

export interface TurnUsage {
  /**
   * 'context': a snapshot of one request (Claude) — the last one in a turn wins; never summed.
   * 'turn': usage billed by the whole turn (Codex) — summable across turns.
   */
  kind: 'context' | 'turn';
  contextTokens: number | null;
  contextWindow: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** Usage from one normalized stream event, or null when the event carries none (or a provider we cannot interpret). */
export function extractUsage(event: Record<string, unknown>, fallbackProvider: Provider | null = null): TurnUsage | null {
  if (event.kind !== 'status' || event.text !== 'token_budget') return null;
  const b = event.tokenBudget;
  if (!b || typeof b !== 'object') return null;
  const budget = b as Record<string, unknown>;
  const provider = typeof event.provider === 'string' && event.provider ? event.provider : fallbackProvider;
  if (provider === 'claude') {
    return {
      kind: 'context',
      contextTokens: num(budget.used),
      contextWindow: num(budget.total) || null,
      inputTokens: num(budget.inputTokens),
      outputTokens: num(budget.outputTokens),
      cacheReadTokens: num(budget.cacheReadTokens),
      cacheCreationTokens: num(budget.cacheCreationTokens),
    };
  }
  if (provider === 'codex') {
    return {
      kind: 'turn',
      contextTokens: null,
      contextWindow: null,
      inputTokens: num(budget.inputTokens),
      outputTokens: num(budget.outputTokens),
      cacheReadTokens: num(budget.cacheReadTokens),
      cacheCreationTokens: num(budget.cacheCreationTokens),
    };
  }
  return null;
}
