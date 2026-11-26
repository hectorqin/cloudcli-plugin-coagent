/**
 * Chat cards for coagent tool calls, drawn by CloudCLI's plugin tool-renderer slot (`renderTool`).
 * spawn_agent / wait_for_agents read like native subagent calls: one row per worker with live status and activity.
 */
import type { AgentDTO, RunDetailDTO, StateDTO } from '../shared/protocol.js';
import { mountDiff } from './diffView.js';
import { CTX_CAVEAT, cardUsageText } from './usage.js';
import { cleanupTarget } from './workspaceCleanup.js';

export interface ToolContext {
  toolName: string;
  toolId: string | null;
  toolInput: unknown;
  toolResult: { content: unknown; isError: boolean } | null;
  status: 'running' | 'completed' | 'error' | 'denied';
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  sessionId: string | null;
}
export interface ToolHost {
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
  openSession(sessionId: string): void;
  archiveProject?(projectPath: string): Promise<{ ok: true } | { ok: false; error: unknown }>;
  deleteProject?(projectPath: string): Promise<unknown>;
  archiveSession?(sessionId: string): Promise<{ ok: true } | { ok: false; error: unknown }>;
  deleteSession?(sessionId: string): Promise<unknown>;
}

const POLL_MS = 2000;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Tool results arrive as a string or as MCP content blocks. */
export function resultText(result: ToolContext['toolResult']): string {
  const c = result?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
  return c == null ? '' : JSON.stringify(c);
}
const input = (ctx: ToolContext) => (ctx.toolInput && typeof ctx.toolInput === 'object' ? ctx.toolInput : {}) as Record<string, unknown>;
const shortName = (toolName: string) => toolName.replace(/^mcp__coagent__/, '');

// One state request per session every POLL_MS, however many cards are on screen.
const cache = new Map<string, { at: number; p: Promise<StateDTO | null> }>();
function loadState(host: ToolHost, sessionId: string | null, force = false): Promise<StateDTO | null> {
  const key = sessionId ?? '';
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < POLL_MS - 200) return hit.p;
  const p = host.rpc('GET', `state${key ? `?session=${encodeURIComponent(key)}` : ''}`).then((s) => s as StateDTO, () => null);
  cache.set(key, { at: Date.now(), p });
  return p;
}

const CSS = `
.cat{--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--card:#f6f8fa;--accent:#0969da;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;
  font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);border:1px solid var(--line);border-radius:8px;background:var(--card);margin:4px 0;overflow:hidden}
.cat.dark{--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--card:#161b22;--accent:#4493f8;--ok:#3fb950;--bad:#f85149;--warn:#d29922}
.cat *{box-sizing:border-box}
.cat-h{display:flex;gap:8px;align-items:center;padding:6px 10px}
.cat-h .t{font-weight:600}.cat-h .s{color:var(--muted);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cat-b{display:inline-flex;align-items:center;gap:4px;padding:0 7px;border-radius:999px;border:1px solid var(--line);font-size:11px;line-height:18px;white-space:nowrap}
.cat-b.run{color:var(--warn);border-color:var(--warn)}.cat-b.ok{color:var(--ok);border-color:var(--ok)}.cat-b.bad{color:var(--bad);border-color:var(--bad)}.cat-b.acc{color:var(--accent);border-color:var(--accent)}
.cat-dot{width:7px;height:7px;border-radius:50%;background:currentColor;animation:cat-p 1s infinite}
@keyframes cat-p{50%{opacity:.25}}
.cat-a{border-top:1px solid var(--line);padding:6px 10px}
.cat-a .row{display:flex;gap:8px;align-items:center}
.cat-a b{font-weight:600}.cat-a .m{color:var(--muted);font-size:12px}
.cat .u{color:var(--muted);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.cat-act{margin:4px 0 0 2px;padding-left:8px;border-left:2px solid var(--line);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.cat-act div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cat-files{margin-top:5px;border:1px solid var(--line);border-radius:5px;overflow:hidden}.cat-file{display:flex;gap:7px;padding:2px 6px;border-top:1px solid var(--line);font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.cat-file:first-child{border-top:0}.cat-file .path{flex:1;min-width:0;overflow-wrap:anywhere}.cat-file .plus{color:var(--ok)}.cat-file .minus{color:var(--bad)}
.cat pre{white-space:pre-wrap;word-break:break-word;margin:4px 0 0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:280px;overflow:auto}
.cat-others>.cat-a{padding-left:0;padding-right:0}.cat-others>.cat-a:last-child{padding-bottom:0}
.cat details>summary{cursor:pointer;color:var(--muted);font-size:12px}
.cat .cad-host{max-height:70vh;overflow:auto}
.cat button{font:inherit;font-size:12px;padding:1px 8px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer;margin-left:auto}
.cat-h button{margin-left:0}
.cat button:hover{border-color:var(--accent);color:var(--accent)}
`;
function ensureStyle() {
  if (document.getElementById('coagent-tool-style')) return;
  const el = document.createElement('style');
  el.id = 'coagent-tool-style';
  el.textContent = CSS;
  document.head.append(el);
}

function statusBadge(a: AgentDTO): string {
  if (a.busy || a.status === 'starting' || a.status === 'running') return '<span class="cat-b run"><span class="cat-dot"></span>working</span>';
  const tone = a.status === 'error' ? 'bad' : a.status === 'reported' || a.status === 'merged' ? 'ok' : a.status === 'lead' ? 'acc' : '';
  return `<span class="cat-b ${tone}">${esc(a.status)}</span>`;
}

function callBadge(ctx: ToolContext): string {
  if (ctx.status === 'running') return '<span class="cat-b run"><span class="cat-dot"></span>running</span>';
  if (ctx.status === 'error' || ctx.status === 'denied') return `<span class="cat-b bad">${esc(ctx.status)}</span>`;
  return '<span class="cat-b ok">done</span>';
}

/** Elapsed time of the running turn (or totals) and context use; "—" for anything unknown. */
function usageSpan(a: AgentDTO): string {
  return a.usage ? `<span class="m u" title="${esc(`turn time · context window use\n${CTX_CAVEAT}`)}">${esc(cardUsageText(a.usage))}</span>` : '';
}

function agentRow(a: AgentDTO, opts: { activity: boolean }): string {
  const acts = opts.activity ? a.activity.slice(-3) : [];
  return `<div class="cat-a"><div class="row"><b>${esc(a.id)}</b><span class="m">${esc(a.role)} · ${esc(a.provider)}</span>${statusBadge(a)}${usageSpan(a)}
      ${a.appSessionId ? `<button data-open="${esc(a.appSessionId)}">Open ↗</button>` : ''}</div>
    ${acts.length ? `<div class="cat-act">${acts.map((x) => `<div title="${esc(x.text)}">${esc(x.text)}</div>`).join('')}</div>` : ''}
    ${a.lastError ? `<div class="m" style="color:var(--bad)">${esc(clip(a.lastError, 200))}</div>` : ''}
    ${a.result ? `<details><summary>Result</summary><pre>${esc(a.result)}</pre></details>` : ''}</div>`;
}

const workersOf = (run: RunDetailDTO) => run.agents.filter((a) => a.role !== 'lead');

/** wait_start windows of the run's lead, oldest first (`end` null = still waiting). */
function waitWindows(run: RunDetailDTO): { agents: string[]; end: number | null }[] {
  const windows: { agents: string[]; end: number | null }[] = [];
  for (const e of run.events) {
    if (e.agentId !== run.run.leadAgentId) continue;
    if (e.type === 'wait_start') {
      windows.push({ agents: Array.isArray(e.data.agents) ? e.data.agents.map(String) : [], end: null });
    } else if (e.type === 'wait_end') {
      const open = windows.findLast((w) => w.end === null);
      if (open) open.end = e.id;
    }
  }
  return windows;
}

/**
 * The targets of a finished wait_for_agents call, from its result text. Current brokers end every finished wait with
 * an authoritative "Waited on: a, b." (or "none") line; that list is used as is (`authoritative`). Older results lack
 * it: then the senders of the delivered messages, the "Still working: …" tail and the time-limit status line are
 * the best guess (only the tail and status line are searched, so a message body cannot add names there).
 */
export function waitResultIds(text: string): { ids: string[]; authoritative: boolean } {
  const tail = text.slice(text.lastIndexOf('\n\n') + 1);
  const waited = tail.match(/^\s*Waited on: ([^\n]*)\.\s*$/);
  const split = (list: string) => list.split(',').map((x) => x.trim()).filter(Boolean);
  if (waited) return { ids: waited[1].trim() === 'none' ? [] : split(waited[1]), authoritative: true };
  const ids = [...text.matchAll(/^### From (\S+) · /gm)].map((m) => m[1]);
  const still = tail.match(/Still working: ([^\n]*?)\.(?:\s|$)/)?.[1];
  if (still) ids.push(...split(still));
  const status = text.startsWith('Stopped waiting') ? text.match(/Status: ([^\n]*?)\.(?:\s|$)/)?.[1] : undefined;
  if (status) ids.push(...status.split(', ').map((x) => x.split(':')[0]));
  return { ids: [...new Set(split(ids.join(',')))], authoritative: false };
}

/**
 * Ids of the workers one wait_for_agents call is about: its explicit `agents`; while running, the targets of the lead's
 * open wait window; once finished, the result's "Waited on" list, else (legacy results) the workers its result names,
 * else the last finished wait window's targets. null = unknown (the card falls back to the run's active workers).
 */
export function waitTargetIds(ctx: ToolContext, run: RunDetailDTO): string[] | null {
  const explicit = Array.isArray(input(ctx).agents) ? (input(ctx).agents as unknown[]).map(String).filter(Boolean) : [];
  if (explicit.length) return explicit;
  const windows = waitWindows(run);
  if (ctx.status === 'running') return windows.findLast((w) => w.end === null)?.agents ?? null;
  const parsed = waitResultIds(resultText(ctx.toolResult));
  if (parsed.authoritative) return parsed.ids;
  const known = new Set(workersOf(run).map((a) => a.id));
  const named = parsed.ids.filter((id) => known.has(id));
  if (named.length) return named;
  return windows.findLast((w) => w.end !== null)?.agents ?? null;
}

/** The workers a call is about, resolved against the run the current session belongs to. */
export function agentsFor(ctx: ToolContext, run: RunDetailDTO | null): AgentDTO[] {
  if (!run) return [];
  const name = shortName(ctx.toolName);
  const text = resultText(ctx.toolResult);
  if (name === 'spawn_agent') {
    const id = text.match(/Spawned (\S+)/)?.[1];
    return run.agents.filter((a) => a.id === id);
  }
  if (name === 'wait_for_agents') {
    const ids = waitTargetIds(ctx, run);
    // Unknown (e.g. the first poll has not been recorded yet): the broker's default, every unfinished worker.
    if (!ids) return workersOf(run).filter((a) => a.busy || (a.status !== 'merged' && a.status !== 'ended'));
    return workersOf(run).filter((a) => ids.includes(a.id));
  }
  if (name === 'request_merge') return run.agents.filter((a) => a.id === input(ctx).worker);
  return [];
}

interface CleanupState { pending: boolean; done: boolean; result: string }
interface CleanupView {
  archiveProject: boolean; deleteProject: boolean; archiveSession: boolean; deleteSession: boolean;
  state?: (agentId: string) => CleanupState | undefined;
}

function cleanupHtml(worker: AgentDTO | undefined, run: RunDetailDTO | null, cleanup: CleanupView): string {
  if (!worker || !run) return '';
  const target = cleanupTarget(worker, run);
  if (!target) return '';
  const archive = target.kind === 'project' ? cleanup.archiveProject : cleanup.archiveSession;
  const del = target.kind === 'project' ? cleanup.deleteProject : cleanup.deleteSession;
  const state = cleanup.state?.(worker.id);
  const disabled = state?.pending ? ' disabled' : '';
  const controls = state?.done ? '' : `${archive ? `<button class="primary" data-clean="archive" data-agent="${esc(worker.id)}"${disabled}>Archive worker session</button>` : ''}
    ${del ? `<button class="danger" data-clean="delete" data-agent="${esc(worker.id)}"${disabled}>Delete</button>` : ''}`;
  const hint = !archive && !del ? `<span class="m">Archive it from the sidebar${target.kind === 'project'
    ? ` (the project is under ${esc(run.run.projectPath.split('/').filter(Boolean).at(-1) ?? 'repo')} → worktrees)` : ''}</span>` : '';
  return `<div class="cat-a"><div class="row">${controls}${hint}</div>${state?.result ? `<div class="m">${esc(state.result)}</div>` : ''}</div>`;
}

export function cardHtml(ctx: ToolContext, state: StateDTO | null, cleanup: CleanupView = {
  archiveProject: false, deleteProject: false, archiveSession: false, deleteSession: false,
}): string {
  const name = shortName(ctx.toolName);
  const run = state?.current ?? null;
  const args = input(ctx);
  const text = resultText(ctx.toolResult);
  const head = (title: string, sub: string, badge = callBadge(ctx)) =>
    `<div class="cat-h"><span class="t">${esc(title)}</span><span class="s">${esc(sub)}</span>${badge}</div>`;
  const resultBlock = text && ctx.status !== 'running' ? `<div class="cat-a"><details><summary>Tool result</summary><pre>${esc(text)}</pre></details></div>` : '';

  switch (name) {
    case 'spawn_agent': {
      // One compact line: live activity is shown once, by the wait_for_agents card at the bottom of the chat.
      const a = agentsFor(ctx, run)[0];
      const who = a ? `${a.id} · ${a.role} · ${a.provider}` : `${String(args.role ?? '')}${args.provider ? ` · ${String(args.provider)}` : ''}`;
      const open = a?.appSessionId ? `<button data-open="${esc(a.appSessionId)}">Open ↗</button>` : '';
      return `<div class="cat-h"><span class="t">Spawned</span><span class="s">${esc(who)} — ${esc(clip(String(args.task ?? ''), 90))}</span>`
        + `${a ? statusBadge(a) + usageSpan(a) : callBadge(ctx)}${open}</div>`
        + (a?.result ? `<div class="cat-a"><details><summary>Result</summary><pre>${esc(a.result)}</pre></details></div>` : '')
        + (a ? '' : resultBlock);
    }
    case 'wait_for_agents': {
      const agents = agentsFor(ctx, run);
      const others = run ? workersOf(run).filter((a) => !agents.includes(a)) : [];
      const mode = args.mode === 'any' ? 'first result' : 'all results';
      const working = agents.filter((a) => a.busy || a.status === 'starting' || a.status === 'running').length;
      const sub = ctx.status === 'running' ? `waiting for ${mode} · ${working} working` : `waited for ${mode}`;
      const rest = others.length ? `<div class="cat-a"><details class="cat-others"><summary>${others.length} other agent${others.length === 1 ? '' : 's'} in this run</summary>`
        + `${others.map((a) => agentRow(a, { activity: false })).join('')}</details></div>` : '';
      return head('Waiting on agents', sub) + agents.map((a) => agentRow(a, { activity: ctx.status === 'running' }) + cleanupHtml(a, run, cleanup)).join('') + rest + resultBlock;
    }
    case 'submit_plan':
    case 'request_merge': {
      const gateId = Number(text.match(/gate #(\d+)/)?.[1] ?? NaN);
      const kind = name === 'submit_plan' ? 'plan' : 'merge';
      const gate = run?.gates.find((g) => g.id === gateId)
        ?? [...(run?.gates ?? [])].reverse().find((g) => g.kind === kind && (kind === 'plan' || g.subjectAgent === args.worker));
      const st = gate?.status ?? (ctx.status === 'running' ? 'pending' : 'unknown');
      const badge = `<span class="cat-b ${st === 'approved' ? 'ok' : st === 'rejected' || st === 'expired' ? 'bad' : 'run'}">${st === 'pending' ? '<span class="cat-dot"></span>' : ''}${esc(st)}</span>`;
      const title = kind === 'plan' ? 'Plan approval' : `Merge approval · ${String(args.worker ?? '')}`;
      const body = String(kind === 'plan' ? args.plan ?? '' : args.note ?? gate?.payload ?? '');
      const hint = st === 'pending' ? '<div class="cat-a m">Waiting for you: answer the form below, or in the CoAgent tab.</div>' : '';
      const review = kind === 'merge' && gate?.snapshot ? `<div class="cat-a"><div class="m">Reviewed commit ${esc(gate.snapshot.workerHead.slice(0, 10))}</div>
        <div class="cat-files">${gate.snapshot.files.map((f) => `<div class="cat-file"><span>${esc(f.status)}</span><span class="path">${f.oldPath ? `${esc(f.oldPath)} → ` : ''}${esc(f.path)}</span>${f.binary
          ? '<span>binary</span>' : `<span class="plus">+${f.additions ?? 0}</span><span class="minus">-${f.deletions ?? 0}</span>`}</div>`).join('')}</div>
        <details data-diff="${gate.id}"><summary>View diff${gate.snapshot.diffTruncated ? ' (truncated at 200 KB)' : ''}</summary></details></div>` : '';
      return head(title, gate?.comment ? `comment: ${gate.comment}` : '', badge)
        + `<div class="cat-a"><details ${st === 'pending' ? 'open' : ''}><summary>${kind === 'plan' ? 'Plan' : 'Note'}</summary><pre>${esc(body)}</pre></details></div>`
        + review + hint + (kind === 'merge' && st === 'approved'
          ? cleanupHtml(run?.agents.find((a) => a.id === gate?.subjectAgent), run, cleanup) : '') + resultBlock;
    }
    case 'send_message':
      return head('Message', `→ ${String(args.to ?? '')}: ${clip(String(args.body ?? ''), 120)}`) + resultBlock;
    case 'report_result':
      return head('Report to lead', clip(String(args.summary ?? ''), 140)) + resultBlock;
    default:
      return head(name.replace(/_/g, ' '), '') + resultBlock;
  }
}

export function renderTool(container: HTMLElement, initial: ToolContext, host: ToolHost) {
  ensureStyle();
  let ctx = initial;
  let state: StateDTO | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  const cleanups = new Map<string, CleanupState>();
  const root = document.createElement('div');
  root.className = 'cat';
  container.append(root);

  const openDetails = () => new Set([...root.querySelectorAll('details')].map((d, i) => (d.open ? i : -1)).filter((i) => i >= 0));
  function draw() {
    const keep = openDetails();
    root.classList.toggle('dark', ctx.theme === 'dark');
    root.innerHTML = cardHtml(ctx, state, {
      archiveProject: typeof host.archiveProject === 'function', deleteProject: typeof host.deleteProject === 'function',
      archiveSession: typeof host.archiveSession === 'function', deleteSession: typeof host.deleteSession === 'function',
      state: (id) => cleanups.get(id),
    });
    root.querySelectorAll('details').forEach((d, i) => { if (keep.has(i)) d.open = true; });
  }
  const live = () => ctx.status === 'running'
    || agentsFor(ctx, state?.current ?? null).some((a) => a.busy || a.status === 'starting' || a.status === 'running');
  async function refresh(force = false) {
    clearTimeout(timer);
    state = await loadState(host, ctx.sessionId, force);
    if (!alive) return;
    draw();
    if (live()) timer = setTimeout(() => { void refresh(); }, POLL_MS);
  }
  root.addEventListener('click', (ev) => {
    const btn = (ev.target as Element).closest<HTMLElement>('[data-open]');
    if (btn) host.openSession(btn.dataset.open!);
    const clean = (ev.target as Element).closest<HTMLButtonElement>('[data-clean]');
    if (!clean || !state?.current) return;
    const worker = state.current.agents.find((a) => a.id === clean.dataset.agent);
    const target = worker ? cleanupTarget(worker, state.current) : null;
    const cleanup = worker ? cleanups.get(worker.id) ?? { pending: false, done: false, result: '' } : null;
    if (!worker || !target || !cleanup || cleanup.pending || cleanup.done) return;
    const action = clean.dataset.clean as 'archive' | 'delete';
    if (action === 'delete' && !confirm(`Delete worker ${target.kind} ${worker.id} (${target.value})? Its sessions and transcripts will be permanently removed.`)) return;
    cleanup.pending = true;
    cleanups.set(worker.id, cleanup);
    draw();
    void Promise.resolve().then(() => action === 'archive'
      ? target.kind === 'project' ? host.archiveProject!(target.value) : host.archiveSession!(target.value)
      : target.kind === 'project' ? host.deleteProject!(target.value) : host.deleteSession!(target.value)).then((result) => {
      if (result && typeof result === 'object' && 'ok' in result && !(result as { ok: boolean }).ok) {
        cleanup.result = `Error: ${String((result as { error?: unknown }).error ?? 'cleanup failed')}`;
      } else {
        cleanup.result = action === 'archive' ? 'Archived' : 'Deleted';
        cleanup.done = true;
        void Promise.resolve().then(() => host.rpc('POST', `runs/${state!.current!.run.id}/workspaces/event`, {
          agentId: worker.id, type: action === 'archive' ? 'workspace_archived' : 'workspace_deleted', kind: target.kind,
        })).catch(() => undefined);
      }
    }, (e) => { cleanup.result = `Error: ${(e as Error).message}`; }).finally(() => { cleanup.pending = false; draw(); });
  });
  root.addEventListener('toggle', (ev) => {
    const el = ev.target as HTMLDetailsElement;
    if (!el.matches('details[data-diff]') || !el.open || el.dataset.loaded) return;
    el.dataset.loaded = 'true';
    const id = Number(el.dataset.diff);
    const gate = state?.current?.gates.find((g) => g.id === id);
    void mountDiff(el, host.rpc, id, { dark: ctx.theme === 'dark', snapshotFiles: gate?.snapshot?.files })
      .then((ok) => { if (!ok) delete el.dataset.loaded; });
  }, true);

  draw();
  void refresh(true);
  return {
    update(next: ToolContext) {
      const statusChanged = next.status !== ctx.status;
      ctx = next;
      draw();
      if (statusChanged) void refresh(true);
    },
    destroy() {
      alive = false;
      clearTimeout(timer);
      root.remove();
    },
  };
}
