import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpCloudCli } from '../src/broker/cloudcli.js';
import { extractUsage } from '../src/broker/usage.js';
import { cardHtml, type ToolContext } from '../src/frontend/toolCards.js';
import {
  agentUsageShort, ctxText, drawerUsageHtml, fmtDuration, fmtTokens, laneUsageHtml, runUsageHtml,
} from '../src/frontend/usage.js';
import type { AgentDTO, AgentUsageDTO, RunDetailDTO, StateDTO } from '../src/shared/protocol.js';
import { assistantText, CLAUDE_TURN, CODEX_TURN, claudeBudget, codexBudget, sseBody } from './fixtures/usage.js';

/** Runs one turn through the real SSE loop of HttpCloudCli.send against a canned /api/agent response. */
async function streamTurn(events: unknown[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-usage-'));
  const cfg = path.join(dir, 'plugins.json'); // absent: the key comes from COAGENT_API_KEY
  const body = sseBody(events);
  // Split mid-event to exercise the SSE buffering.
  const chunks = [body.slice(0, 57), body.slice(57, 400), body.slice(400)].map((c) => new TextEncoder().encode(c));
  const fetchImpl = (async () => new Response(new ReadableStream({
    start(ctl) { for (const c of chunks) ctl.enqueue(c); ctl.close(); },
  }), { status: 200 })) as unknown as typeof fetch;
  const prev = process.env.COAGENT_API_KEY;
  process.env.COAGENT_API_KEY = 'ck_test';
  try {
    const cc = new HttpCloudCli({ pluginsConfigPath: cfg, localServerPath: path.join(dir, 'none.json'), fetchImpl });
    const seen: Record<string, unknown>[] = [];
    const res = await cc.send({ projectPath: '/x', provider: 'claude', message: 'hi' }, undefined, (e) => seen.push(e));
    return { res, seen };
  } finally {
    if (prev === undefined) delete process.env.COAGENT_API_KEY; else process.env.COAGENT_API_KEY = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const lastUsage = (events: Record<string, unknown>[]) =>
  events.map((e) => extractUsage(e)).filter((u) => u !== null).at(-1) ?? null;

describe('usage extraction from the SSE stream', () => {
  it('Claude: token_budget events are context snapshots; the last one describes the turn', async () => {
    const { res, seen } = await streamTurn(CLAUDE_TURN);
    expect(res).toEqual({ status: 'ok', appSessionId: 'app-claude' });
    expect(seen.filter((e) => e.text === 'token_budget')).toHaveLength(2);
    expect(lastUsage(seen)).toEqual({
      kind: 'context', contextTokens: 45_310, contextWindow: 200_000, inputTokens: 44_810, outputTokens: 500,
      cacheReadTokens: 40_000, cacheCreationTokens: 4_400,
    });
  });

  it('Codex: one per-turn bill; the 200000 default window and per-turn `used` are not taken as context', async () => {
    const { seen } = await streamTurn(CODEX_TURN);
    expect(lastUsage(seen)).toEqual({
      kind: 'turn', contextTokens: null, contextWindow: null, inputTokens: 15_000, outputTokens: 300,
      cacheReadTokens: null, cacheCreationTokens: null,
    });
  });

  it('ignores other events, malformed budgets and unknown providers; falls back to the agent provider', () => {
    expect(extractUsage({ kind: 'text', role: 'assistant', content: 'x' })).toBeNull();
    expect(extractUsage({ kind: 'status', text: 'token_budget' })).toBeNull();
    expect(extractUsage({ ...claudeBudget(1, 1, 0), provider: 'opencode' })).toBeNull();
    const noProvider = { ...codexBudget(10, 2), provider: undefined };
    expect(extractUsage(noProvider)).toBeNull();
    expect(extractUsage(noProvider, 'codex')).toMatchObject({ kind: 'turn', inputTokens: 10 });
    const bad = claudeBudget(5, 5, 0);
    (bad.tokenBudget as Record<string, unknown>).used = 'lots';
    (bad.tokenBudget as Record<string, unknown>).total = 0;
    expect(extractUsage(bad)).toMatchObject({ contextTokens: null, contextWindow: null, inputTokens: 5 });
  });
});

const unknown: AgentUsageDTO = { turns: 0, totalMs: null, currentTurnMs: null, lastContextTokens: null, contextWindow: null, inputTokens: null, outputTokens: null };
const known: AgentUsageDTO = { turns: 3, totalMs: 250_000, currentTurnMs: null, lastContextTokens: 45_310, contextWindow: 200_000, inputTokens: 1_234_567, outputTokens: 4_500 };

describe('usage formatting', () => {
  it('formats tokens and durations, and shows — for unknown', () => {
    expect([fmtTokens(null), fmtTokens(0), fmtTokens(999), fmtTokens(4_500), fmtTokens(45_310), fmtTokens(1_234_567)])
      .toEqual(['—', '0', '999', '4.5k', '45k', '1.2M']);
    expect([fmtDuration(null), fmtDuration(42_900), fmtDuration(250_000), fmtDuration(3_720_000)]).toEqual(['—', '42s', '4m 10s', '1h 02m']);
    expect(ctxText(known)).toBe('ctx 45k/200k');
    expect(ctxText(unknown)).toBe('ctx —/—');
    expect(agentUsageShort(unknown)).toBe('0 turns · — · ctx —/—');
  });

  it('tab snippets: lane header, drawer and run header, known vs unknown, escaped', () => {
    expect(laneUsageHtml(known)).toContain('3 turns · 4m 10s · ctx 45k/200k');
    expect(laneUsageHtml(known)).toContain('title="3 turns · 4m 10s · ctx 45k/200k · in 1.2M · out 4.5k\n');
    // Context use is approximate (CloudCLI may fall back to a cumulative turn bill): every place says so.
    expect(laneUsageHtml(known)).toContain('Approximate');
    expect(drawerUsageHtml(known)).toContain('Approximate');
    expect(drawerUsageHtml(unknown)).toContain('0 turns · — · ctx —/— · in — · out —');
    expect(runUsageHtml({ turns: 5, totalMs: 61_000, inputTokens: null, outputTokens: 900 })).toContain('5 turns · 1m 01s · in — · out 900');
    expect(laneUsageHtml(undefined)).toBe('');
    expect(drawerUsageHtml(undefined)).toBe('');
    expect(runUsageHtml(undefined)).toBe('');
  });
});

describe('usage on chat cards', () => {
  const agent = (id: string, usage: AgentUsageDTO, extra: Partial<AgentDTO> = {}): AgentDTO => ({
    id, runId: 'r', role: 'coder', provider: 'claude', providerSessionId: null, appSessionId: `app-${id}`, cwd: '/x', branch: null,
    worktreePath: null, status: 'idle', task: null, result: null, lastError: null, busy: false, activity: [], usage, ...extra,
  });
  const run: RunDetailDTO = {
    run: { id: 'r', leadAgentId: 'lead', projectPath: '/x', status: 'active', planStatus: 'approved', createdAt: '', usage: { turns: 0, totalMs: null, inputTokens: null, outputTokens: null } },
    agents: [
      agent('lead', unknown, { role: 'lead', status: 'lead' }),
      agent('coder-1', { ...known, currentTurnMs: 83_000 }, { busy: true, status: 'running' }),
      agent('reviewer-2', unknown, { provider: 'codex', status: 'starting' }),
    ],
    messages: [], events: [], gates: [],
  };
  const state = { setup: { apiKeyConfigured: true, registration: {} }, me: 'lead', current: run, runs: [] } as StateDTO;
  const ctx = (toolName: string, toolInput: unknown, result: string | null, status: ToolContext['status'] = 'running'): ToolContext => ({
    toolName: `mcp__coagent__${toolName}`, toolId: 't', toolInput, status, theme: 'dark', project: null, sessionId: 'app-lead',
    toolResult: result === null ? null : { content: [{ type: 'text', text: result }], isError: false },
  });

  it('wait_for_agents: elapsed time of the current turn and context use per worker; — when unknown', () => {
    const html = cardHtml(ctx('wait_for_agents', {}, null), state);
    expect(html).toContain('turn 1m 23s · ctx 45k/200k');
    expect(html).toContain('0 turns · — · ctx —/—');
  });

  it('spawn_agent: the spawned worker line carries its usage', () => {
    const html = cardHtml(ctx('spawn_agent', { role: 'coder', task: 't' }, 'Spawned coder-1 (role coder, provider claude) in /x', 'completed'), state);
    expect(html).toContain('turn 1m 23s · ctx 45k/200k');
  });
});

describe('aborted runs (real SSE sequence)', () => {
  it('a run a tab aborted after acceptance resolves as aborted, not ok or error', async () => {
    // agent.routes.ts:834/:1165-1167 and createCompleteMessage (shared/utils.ts:535-553).
    const { res, seen } = await streamTurn([
      { type: 'status', message: 'Agent started', projectPath: '/x' },
      { type: 'session-id', sessionId: 'app-claude' },
      assistantText('claude', 'working'),
      claudeBudget(12_000, 11_800, 200),
      { kind: 'complete', provider: 'claude', sessionId: 'app-claude', actualSessionId: 'app-claude', exitCode: 1, success: false, aborted: true },
      { type: 'status', message: 'Run aborted', aborted: true },
      { type: 'done' },
    ]);
    expect(res).toEqual({ status: 'aborted', appSessionId: 'app-claude' });
    expect(lastUsage(seen)).toMatchObject({ contextTokens: 12_000 });
  });

  it('a normal complete is still ok', async () => {
    expect((await streamTurn(CLAUDE_TURN)).res.status).toBe('ok');
  });
});
