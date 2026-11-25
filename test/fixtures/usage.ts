/**
 * Stream events shaped exactly like CloudCLI v1.37.10 emits them (see src/broker/usage.ts for the source lines):
 * createNormalizedMessage adds id/sessionId/timestamp/provider; tokenBudget comes from Claude's buildTokenBudget
 * (one per assistant message) or Codex's extractCodexTokenBudget (one per turn.completed).
 */
export const claudeBudget = (used: number, input: number, output: number, total = 200_000, cacheRead = 0, cacheCreation = 0) => ({
  kind: 'status', text: 'token_budget', provider: 'claude', sessionId: 'prov-claude', id: `status_${used}`,
  timestamp: '2026-11-25T09:00:00.000Z',
  tokenBudget: {
    used, total, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation,
    cacheTokens: cacheRead + cacheCreation, breakdown: { input, output },
  },
});

/** Codex: `used` is input+output of the turn and `total` the hard-coded 200000 default (no model_context_window). */
export const codexBudget = (input: number, output: number) => ({
  kind: 'status', text: 'token_budget', provider: 'codex', sessionId: 'thread-codex', id: `status_c${input}`,
  timestamp: '2026-11-25T09:00:00.000Z',
  tokenBudget: { used: input + output, total: 200_000, inputTokens: input, outputTokens: output, breakdown: { input, output } },
});

export const assistantText = (provider: 'claude' | 'codex', content: string) => ({
  kind: 'text', role: 'assistant', content, provider, sessionId: 's', id: `text_${content.length}`, timestamp: '2026-11-25T09:00:00.000Z',
});

/** One SSE body as /api/agent streams it: route events are objects, runtime events are pre-serialized JSON. */
export function sseBody(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

export const CLAUDE_TURN = [
  { type: 'session-id', sessionId: 'app-claude' },
  assistantText('claude', 'Reading the code'),
  claudeBudget(30_120, 29_900, 220, 200_000, 25_000, 4_000),
  { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' }, toolId: 'tu1', provider: 'claude' },
  claudeBudget(45_310, 44_810, 500, 200_000, 40_000, 4_400),
  { kind: 'complete', exitCode: 0, success: true, provider: 'claude', sessionId: 'prov-claude' },
  { type: 'done' },
];

export const CODEX_TURN = [
  { type: 'session-id', sessionId: 'app-codex' },
  { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' }, toolId: 'item_1', itemId: 'item_1', provider: 'codex' },
  assistantText('codex', 'Done.'),
  codexBudget(15_000, 300),
  { kind: 'complete', exitCode: 0, success: true, provider: 'codex', sessionId: 'thread-codex' },
  { type: 'done' },
];
