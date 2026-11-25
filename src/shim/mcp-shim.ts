/**
 * coagent MCP shim: a thin stdio MCP server that Claude/Codex spawn per session.
 * It observes who is calling (never trusting the model for that) and forwards each tool call to the broker.
 *   - Claude: the MCP process inherits CLAUDE_CODE_SESSION_ID.
 *   - Codex: the MCP env is scrubbed, but every tools/call carries _meta["x-codex-turn-metadata"].thread_id.
 * Two calls stay open the way a native subagent call does: wait_for_agents (polls the broker until the workers
 * are done) and, for Claude leads, submit_plan/request_merge (asks the user inline via MCP elicitation).
 */
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Caller, ToolName, ToolResponse } from '../shared/protocol.js';
import { RUNTIME_FILE } from '../broker/paths.js';
import { VERSION } from '../shared/version.js';

const POLL_MS = 2500;
const WAIT_LIMIT_MS = 30 * 60 * 1000;
const GATE_LIMIT_MS = 100 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

export function callerFrom(env: NodeJS.ProcessEnv, meta: Record<string, unknown> | undefined, cwd: string): Caller {
  // Codex metadata is per request, so it wins over an env var that could have leaked in from an outer Claude session.
  const turn = (meta?.['x-codex-turn-metadata'] ?? {}) as Record<string, unknown>;
  const thread = turn.thread_id ?? turn.session_id ?? meta?.threadId;
  if (typeof thread === 'string' && thread) {
    return { provider: 'codex', providerSessionId: thread, cwd: typeof turn.cwd === 'string' ? turn.cwd : cwd };
  }
  if (env.CLAUDE_CODE_SESSION_ID) {
    return { provider: 'claude', providerSessionId: env.CLAUDE_CODE_SESSION_ID, cwd: env.CLAUDE_PROJECT_DIR ?? cwd };
  }
  return { provider: null, providerSessionId: null, cwd };
}

async function call(tool: ToolName, args: Record<string, unknown>, caller: Caller): Promise<ToolResponse> {
  let rt: { port: number; token: string };
  try {
    rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  } catch {
    return { ok: false, text: 'CoAgent broker is not running. Enable the CoAgent plugin in CloudCLI.' };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${rt.port}/mcp/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coagent-token': rt.token },
      body: JSON.stringify({ tool, args, caller }),
    });
    const body = (await res.json()) as ToolResponse | { error: string };
    return 'text' in body ? body : { ok: false, text: `broker error: ${body.error}` };
  } catch (e) {
    return { ok: false, text: `CoAgent broker unreachable: ${(e as Error).message}` };
  }
}

const reply = (r: Pick<ToolResponse, 'ok' | 'text'>) => ({ content: [{ type: 'text' as const, text: r.text }], isError: !r.ok });
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

type Extra = {
  _meta?: Record<string, unknown>;
  signal: AbortSignal;
  sendNotification: (n: { method: 'notifications/progress'; params: Record<string, unknown> }) => Promise<void>;
};

/** Keeps the call open while the broker says `pending`, reporting progress (which also keeps idle timeouts away). */
async function pollUntilDone(
  tool: ToolName, args: Record<string, unknown>, caller: Caller, extra: Extra, limitMs: number, signal: AbortSignal = extra.signal,
) {
  const started = Date.now();
  const token = extra._meta?.progressToken;
  let lastProgress = '';
  let lastSent = 0;
  let step = 0;
  for (;;) {
    const res = await call(tool, args, caller);
    if (!res.pending || signal.aborted) return res;
    if (Date.now() - started > limitMs) return call(tool, { ...args, give_up: true }, caller);
    const now = Date.now();
    if (token !== undefined && (res.progress !== lastProgress || now - lastSent > HEARTBEAT_MS)) {
      lastProgress = res.progress ?? '';
      lastSent = now;
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: ++step, message: res.progress ?? res.text },
      }).catch(() => undefined);
    }
    await sleep(POLL_MS, signal);
  }
}

const DECISION_SCHEMA = {
  type: 'object' as const,
  properties: {
    decision: { type: 'string' as const, title: 'Decision', enum: ['approve', 'reject'], enumNames: ['Approve', 'Reject'] },
    comment: { type: 'string' as const, title: 'Comment for the lead (optional)' },
  },
  required: ['decision'],
};

/**
 * Asks the user inside the lead's own chat (MCP elicitation), while also watching the broker so a decision made in
 * the CoAgent tab wins too. Falls back to the asynchronous gate when the client cannot show the form.
 */
async function decideInline(server: McpServer, opened: ToolResponse, caller: Caller, extra: Extra) {
  const gate = opened.gate!;
  const files = gate.snapshot?.files ?? [];
  const fileSummary = files.length ? `\n\nFiles (${files.length}):\n${files.slice(0, 30).map((f) => {
    const counts = f.binary ? 'binary' : `+${f.additions ?? 0} -${f.deletions ?? 0}`;
    return `- ${f.status} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path} (${counts})`;
  }).join('\n')}${files.length > 30 ? `\n- … and ${files.length - 30} more` : ''}\n\nFull diff in the CoAgent tab.` : '';
  // On promotion the broker prepends the lead protocol; keep it in whatever we return.
  const sep = '\n\n---\n\n';
  const prefix = opened.text.includes(sep) ? `${opened.text.split(sep)[0]}${sep}` : '';
  const formAbort = new AbortController();
  const watchAbort = new AbortController();
  extra.signal.addEventListener('abort', () => { formAbort.abort(); watchAbort.abort(); }, { once: true });

  const form = server.server.elicitInput(
    { message: `${gate.title}\n\n${gate.body}${fileSummary}`, requestedSchema: DECISION_SCHEMA },
    { signal: formAbort.signal, timeout: GATE_LIMIT_MS },
  ).then((r) => ({ from: 'form' as const, r }), () => ({ from: 'form' as const, r: null }));
  const watch = pollUntilDone('gate_wait', { gate: gate.id }, caller, extra, GATE_LIMIT_MS, watchAbort.signal)
    .then((r) => ({ from: 'tab' as const, r }));

  const first = await Promise.race([form, watch]);
  watchAbort.abort(); // stop polling (and holding the lead's inbox) whichever way it went
  if (first.from === 'tab') {
    formAbort.abort(); // retract the form: decided in the tab (or we stopped waiting)
    // Still pending only when the wait hit its limit: leave the gate open in the tab.
    return reply(first.r.pending ? { ok: true, text: opened.text } : { ok: first.r.ok, text: prefix + first.r.text });
  }
  const answer = first.r;
  if (!answer || answer.action !== 'accept') {
    // Declined, dismissed, or the client cannot show forms (e.g. an unattended run): keep the gate open in the tab.
    return reply({ ok: true, text: opened.text });
  }
  const content = (answer.content ?? {}) as Record<string, unknown>;
  const decided = await call('gate_decide', {
    gate: gate.id, approve: content.decision === 'approve', comment: typeof content.comment === 'string' ? content.comment : '',
  }, caller);
  return reply({ ok: decided.ok, text: prefix + decided.text });
}

const agentId = z.string().optional()
  .describe('Your coagent agent id, if your first message gave you one. Omit if you are the lead or were never given one.');

const TOOLS: { name: ToolName; description: string; shape: z.ZodRawShape }[] = [
  {
    name: 'submit_plan',
    description: 'Start (or continue) leading a coagent multi-agent run: submit your plan for the user to approve. '
      + 'Calling this makes the current session the LEAD and returns the lead protocol. Use it when the user asks you to '
      + 'delegate work to sub-agents / workers. The user may approve right here; otherwise end your turn and wait.',
    shape: { plan: z.string().describe('Sub-tasks, the role for each (planner/coder/reviewer/tester), order, and how to verify.') },
  },
  {
    name: 'spawn_agent',
    description: 'LEAD ONLY, after plan approval: start a worker agent in its own CloudCLI session. '
      + 'Writing roles (coder, tester, custom) get a dedicated git worktree+branch; planner/reviewer are read-only.',
    shape: {
      role: z.string().describe('planner | coder | reviewer | tester | custom role name'),
      task: z.string().describe('Self-contained task: goal, relevant files, constraints, definition of done.'),
      provider: z.enum(['claude', 'codex']).optional().describe('Defaults per role (writer and reviewer differ).'),
    },
  },
  {
    name: 'wait_for_agents',
    description: 'LEAD ONLY: block until workers finish and get their results in one go, like waiting on subagents. '
      + 'mode "all" (default) returns when every targeted worker is done — use it for independent parallel tasks. '
      + 'mode "any" returns as soon as one worker reports — use it when later steps depend on earlier results or you '
      + 'want to send rework early. Always returns early on a failure, a worker question, a user message or a gate '
      + 'decision. If it says workers are still working, call it again.',
    shape: {
      agents: z.array(z.string()).optional().describe('Worker ids to wait for; default: every active worker.'),
      mode: z.enum(['all', 'any']).optional(),
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to another agent in your run ("lead" addresses the lead). Delivered when it is idle.',
    shape: { to: z.string(), body: z.string(), agent_id: agentId },
  },
  {
    name: 'read_inbox',
    description: 'Fetch messages addressed to you that have not been delivered yet.',
    shape: { agent_id: agentId },
  },
  {
    name: 'report_result',
    description: 'WORKERS: report your finished work to the lead (what changed, files, verification, open issues). '
      + 'Then end your turn.',
    shape: { summary: z.string(), agent_id: agentId },
  },
  {
    name: 'request_merge',
    description: "LEAD ONLY: ask the user to approve merging a worker's branch into your checked-out branch. "
      + 'The user may decide right here; otherwise end your turn and wait.',
    shape: { worker: z.string().describe('Worker agent id'), note: z.string().optional() },
  },
  {
    name: 'end_agent',
    description: 'LEAD ONLY: end a worker you no longer need (e.g. a finished reviewer, an abandoned or interrupted '
      + 'coder). It stops receiving messages and frees its worker slot; a pending merge request for it is rejected. '
      + 'Its unmerged worktree is kept unless remove_worktree is true; its branch is always kept.',
    shape: {
      worker: z.string().describe('Worker agent id'),
      remove_worktree: z.boolean().optional().describe('Also delete its unmerged worktree (default false).'),
    },
  },
  {
    name: 'list_agents',
    description: 'List the agents in your run with role, provider, status and working directory.',
    shape: { agent_id: agentId },
  },
];

async function main() {
  const server = new McpServer({ name: 'coagent', version: VERSION });
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (rawArgs, rawExtra) => {
      const extra = rawExtra as unknown as Extra;
      const args = rawArgs as Record<string, unknown>;
      const caller = callerFrom(process.env, extra._meta, process.cwd());

      if (t.name === 'wait_for_agents') return reply(await pollUntilDone(t.name, args, caller, extra, WAIT_LIMIT_MS));

      const res = await call(t.name, args, caller);
      // Inline approval only for Claude: CloudCLI bridges Claude's elicitation to the chat, not Codex's.
      const canAsk = !!server.server.getClientCapabilities()?.elicitation && caller.provider === 'claude';
      if (res.ok && res.gate && canAsk) return decideInline(server, res, caller, extra);
      return reply(res);
    });
  }
  await server.connect(new StdioServerTransport());
}

if (!process.env.VITEST) void main();
