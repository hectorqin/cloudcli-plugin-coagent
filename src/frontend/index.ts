/** CoAgent tab. Bundled into one ES module (the host imports it from a Blob URL). */
import type { AgentDTO, GateDTO, RunDetailDTO, StateDTO } from '../shared/protocol.js';
import { mountDiff } from './diffView.js';
import { buildTimeline, type Ref, type Row, type Timeline, type Tone, USER_LANE } from './timeline.js';
import { drawerUsageHtml, laneUsageHtml, runUsageHtml, runUsageText } from './usage.js';

interface PluginContext {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
}
interface PluginAPI {
  readonly context: PluginContext;
  onContextChange(cb: (ctx: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
}

const POLL_MS = 2000;
const GUTTER = 64;
const ROW_H = 40;
const TICK_H = 12;
const LANE_COLORS = ['#8b949e', '#4493f8', '#a371f7', '#3fb950', '#d29922', '#db61a2', '#39c5cf'];
let teardown: (() => void) | null = null;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);
const hms = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const CSS = `
.ca{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--card:#f6f8fa;--accent:#0969da;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;
  font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg);min-height:100%;box-sizing:border-box;display:flex;flex-direction:column}
.ca.dark{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--card:#161b22;--accent:#4493f8;--ok:#3fb950;--bad:#f85149;--warn:#d29922}
.ca *{box-sizing:border-box}
.ca .pad{padding:12px 16px}
.ca h2{font-size:15px;margin:0}.ca h3{font-size:12px;margin:14px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.ca .sub{color:var(--muted);font-size:12px}
.ca .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.ca .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ca .grow{flex:1;min-width:0}
.ca .badge{display:inline-block;padding:0 7px;border-radius:999px;border:1px solid var(--line);font-size:11px;line-height:18px;white-space:nowrap}
.ca .t-accent,.ca .b-lead{color:var(--accent);border-color:var(--accent)}.ca .t-warn,.ca .b-running,.ca .b-starting,.ca .b-pending,.ca .b-interrupted{color:var(--warn);border-color:var(--warn)}
.ca .t-ok,.ca .b-reported,.ca .b-merged,.ca .b-approved{color:var(--ok);border-color:var(--ok)}.ca .t-error,.ca .b-error,.ca .b-rejected,.ca .b-expired{color:var(--bad);border-color:var(--bad)}
.ca pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:40vh;overflow:auto}
.ca .files{margin:6px 0;border:1px solid var(--line);border-radius:6px;overflow:hidden}.ca .file{display:flex;gap:8px;padding:3px 7px;border-top:1px solid var(--line);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.ca .file:first-child{border-top:0}.ca .file .path{flex:1;min-width:0;overflow-wrap:anywhere}.ca .plus{color:var(--ok)}.ca .minus{color:var(--bad)}
.ca details>summary{cursor:pointer;color:var(--muted)}
.ca button{font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;white-space:nowrap}
.ca button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.ca button.danger{color:var(--bad)}
.ca button:disabled{opacity:.5;cursor:default}
.ca textarea,.ca input{font:inherit;width:100%;padding:5px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.ca textarea{min-height:52px;resize:vertical}
.ca .err{color:var(--bad)}
.ca .top{position:sticky;top:0;z-index:3;background:var(--bg);border-bottom:1px solid var(--line)}
.ca .pending{display:flex;gap:8px;align-items:center;padding:6px 16px;background:color-mix(in srgb,var(--warn) 14%,var(--bg));border-top:1px solid var(--line)}
.ca .scroll{overflow-x:auto;flex:1}
.ca .lanes{display:flex;position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line)}
.ca .lane-h{padding:6px 8px;border-left:1px solid var(--line);cursor:pointer;overflow:hidden}
.ca .lane-h:hover{background:var(--card)}.ca .lane-h.me{box-shadow:inset 0 -2px 0 var(--accent)}
.ca .lane-h b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ca svg{display:block}
.ca svg .hit{cursor:pointer}.ca svg .hit:hover text{text-decoration:underline}
.ca svg text{font:12px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--fg)}
.ca svg .time{fill:var(--muted);font-size:11px}
.ca .drawer{position:sticky;bottom:0;z-index:3;background:var(--card);border-top:1px solid var(--line);padding:10px 16px;max-height:55vh;overflow:auto}
.ca .spin{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--warn);animation:ca-p 1s infinite}
@keyframes ca-p{50%{opacity:.25}}
.ca .pulse{animation:ca-p 1.2s infinite}
`;

const toneColor = (t: Tone) => ({ neutral: 'var(--fg)', ok: 'var(--ok)', accent: 'var(--accent)', warn: 'var(--warn)', error: 'var(--bad)', muted: 'var(--muted)' })[t];

export function mount(container: HTMLElement, api: PluginAPI) {
  const root = document.createElement('div');
  root.className = 'ca';
  const style = document.createElement('style');
  style.textContent = CSS;
  container.append(style, root);

  let state: StateDTO | null = null;
  let lastJson = '';
  let error = '';
  let selectedRun: string | null = null;
  let selected: Ref | { type: 'agent'; id: string } | null = null;
  let firstPaint = true;
  let diagnosticsOpen = false;
  let diagnostics: unknown = null;
  const drafts = new Map<string, string>();
  /** Gate diffs the user opened: kept open across re-renders (the diff itself is cached by diffView). */
  const openDiffs = new Set<number>();

  const applyTheme = () => root.classList.toggle('dark', api.context.theme === 'dark');
  applyTheme();

  async function refresh(force = false) {
    const ctx = api.context;
    const q = new URLSearchParams();
    if (ctx.session?.id) q.set('session', ctx.session.id);
    if (selectedRun) q.set('run', selectedRun);
    try {
      const next = (await api.rpc('GET', `state?${q}`)) as StateDTO;
      error = '';
      const json = JSON.stringify(next);
      if (!force && json === lastJson) return;
      state = next;
      lastJson = json;
    } catch (e) {
      error = (e as Error).message;
    }
    render();
  }

  async function act(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { error = (e as Error).message; }
    await refresh(true);
  }

  function render() {
    // Never re-render under the user's cursor; the next poll after blur catches up.
    const active = document.activeElement;
    if (active && root.contains(active) && /^(TEXTAREA|INPUT)$/.test(active.tagName)) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    const keepTop = container.scrollTop;
    const scroller = root.querySelector<HTMLElement>('.scroll');
    const keepLeft = scroller?.scrollLeft ?? 0;
    root.innerHTML = view();
    for (const el of root.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('[data-draft]')) {
      el.value = drafts.get(el.dataset.draft!) ?? '';
      el.addEventListener('input', () => drafts.set(el.dataset.draft!, el.value));
    }
    for (const el of root.querySelectorAll<HTMLDetailsElement>('details[data-diff]')) if (openDiffs.has(Number(el.dataset.diff))) el.open = true;
    const sc = root.querySelector<HTMLElement>('.scroll');
    if (sc) sc.scrollLeft = keepLeft;
    container.scrollTop = firstPaint || atBottom ? container.scrollHeight : keepTop;
    if (state?.current) firstPaint = false;
  }

  // ── views ───────────────────────────────────────────────────────
  function view(): string {
    const errHtml = error ? `<div class="pad err">${esc(error)}</div>` : '';
    if (!state) return `<div class="pad"><h2>CoAgent</h2><div class="sub">Loading…</div></div>${errHtml}`;
    if (!state.setup.apiKeyConfigured) {
      return `<div class="pad"><h2>CoAgent</h2>${errHtml}<div class="card" style="margin-top:10px"><b>Setup needed.</b>
        CoAgent dispatches agents through CloudCLI's Agent API. Create a key in CloudCLI Settings → API Keys and paste it here.
        It is verified against CloudCLI and stored as this plugin's secret in <code>~/.claude-code-ui/plugins.json</code>.
        <div class="row" style="margin-top:8px"><input class="grow" style="width:auto" type="password" data-draft="apikey" placeholder="ck_…">
        <button class="primary" data-act="setup">Save</button></div></div></div>`;
    }
    return state.current ? runView(state.current, errHtml) : runsView(errHtml);
  }

  function header(extra = '') {
    const reg = Object.entries(state!.setup.registration).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ') || 'pending';
    return `<div class="row pad" style="padding-bottom:8px"><div class="grow"><h2>CoAgent</h2><div class="sub">MCP: ${reg} · automatic registration ${state!.setup.autoRegister ? 'on' : 'off'}</div></div>
      <button data-act="register">Register MCP</button><button class="danger" data-act="unregister">Unregister MCP</button>
      <button data-act="diagnostics">${diagnosticsOpen ? 'Hide diagnostics' : 'Diagnostics'}</button>${extra}</div>${diagnosticsView()}`;
  }

  function diagnosticsView() {
    if (!diagnosticsOpen) return '';
    return `<div class="pad" style="padding-top:0"><div class="card"><b>Diagnostics</b>
      ${diagnostics === null ? '<div class="sub">Loading…</div>' : `<pre>${esc(JSON.stringify(diagnostics, null, 2))}</pre>`}</div></div>`;
  }

  function runsView(errHtml: string): string {
    const runs = state!.runs;
    const intro = `<div class="card sub">This session is not part of a coagent run. Ask any Claude or Codex session to
      “plan this and delegate it to sub-agents”: it calls <code>submit_plan</code> and becomes the lead.</div>`;
    return `${header()}${errHtml}<div class="pad" style="padding-top:0">${intro}${runs.length ? `<h3>Runs</h3>${runs.map((r) => `<div class="card row">
      <div class="grow"><b>${esc(r.id)}</b> <span class="badge b-${esc(r.status)}">${esc(r.status)}</span>
        <span class="badge b-${esc(r.planStatus)}">plan ${esc(r.planStatus)}</span>${r.pendingGates ? ` <span class="badge b-pending">${r.pendingGates} waiting for you</span>` : ''}
        <div class="sub">${esc(r.projectPath)} · ${r.agentCount} agents · ${esc(new Date(r.createdAt).toLocaleString())}</div>
        ${r.usage ? `<div class="sub">${esc(runUsageText(r.usage))}</div>` : ''}</div>
      <button data-act="open-run" data-id="${esc(r.id)}">View</button></div>`).join('')}` : ''}</div>`;
  }

  function runView(d: RunDetailDTO, errHtml: string): string {
    const tl = buildTimeline(d);
    const ended = d.run.status === 'ended';
    const pending = d.gates.filter((g) => g.status === 'pending');
    const top = `<div class="top">${header(`${selectedRun ? '<button data-act="back">All runs</button>' : ''}
        ${ended ? '<span class="badge">ended</span>' : `<button class="danger" data-act="end" data-id="${esc(d.run.id)}">End run</button>`}`)}
      <div class="sub" style="padding:0 16px 8px">Run <b>${esc(d.run.id)}</b> · ${esc(d.run.projectPath)}${runUsageHtml(d.run.usage)}</div>
      ${pending.map((g) => `<div class="pending"><span class="grow">Waiting for you: <b>${g.kind === 'plan'
        ? `plan #${g.id} from ${esc(g.requestedBy)}` : `merge ${esc(g.subjectAgent)} (#${g.id})`}</b></span>
        <button class="primary" data-act="select" data-type="gate" data-id="${g.id}">Review</button></div>`).join('')}
      ${errHtml}</div>`;
    return top + timelineView(tl, d) + drawer(d);
  }

  function timelineView(tl: Timeline, d: RunDetailDTO): string {
    const width = Math.max(container.clientWidth, 360);
    const laneW = Math.max(150, Math.min(260, Math.floor((width - GUTTER) / tl.lanes.length)));
    const totalW = GUTTER + laneW * tl.lanes.length;
    const cx = (lane: number) => GUTTER + laneW * lane + laneW / 2;
    const ys: number[] = [];
    let y = 14;
    for (const r of tl.rows) { const h = r.kind === 'tick' ? TICK_H : ROW_H; ys.push(y + h / 2); y += h; }
    const height = Math.max(y + 24, 120);
    const agents = new Map(d.agents.map((a) => [a.id, a]));

    const heads = tl.lanes.map((l, i) => {
      const a = agents.get(l.id);
      const sel = selected?.type === 'agent' && selected.id === l.id;
      return `<div class="lane-h ${state!.me === l.id ? 'me' : ''}" style="width:${laneW}px;${sel ? 'background:var(--card)' : ''}"
        ${l.id === USER_LANE ? '' : `data-act="select" data-type="agent" data-id="${esc(l.id)}"`}>
        <b style="color:${LANE_COLORS[i % LANE_COLORS.length]}">${esc(l.label)}${state!.me === l.id ? ' · this session' : ''}</b>
        <div class="sub">${esc(l.sub)}</div>
        ${a ? `<span class="badge b-${esc(a.status)}">${a.busy ? '<span class="spin"></span> ' : ''}${esc(a.status)}</span>` : ''}
        ${a ? laneUsageHtml(a.usage) : ''}</div>`;
    }).join('');

    const parts: string[] = [];
    // lane guides
    tl.lanes.forEach((_, i) => parts.push(`<line x1="${cx(i)}" y1="0" x2="${cx(i)}" y2="${height}" stroke="var(--line)" stroke-dasharray="2 4"/>`));
    // turn bars (an agent actively working)
    for (const b of tl.bars) {
      const y1 = ys[b.start] ?? 0;
      const y2 = b.end === null ? height - 8 : (ys[b.end] ?? y1);
      const h = Math.max(6, y2 - y1);
      if (b.kind === 'wait') {
        // The lead blocked in wait_for_agents: an outlined bar beside its turn bar.
        parts.push(`<rect x="${cx(b.lane) + 6}" y="${y1}" width="6" height="${h}" rx="3" fill="none" stroke="var(--accent)"
          stroke-dasharray="3 3" ${b.end === null ? 'class="pulse"' : ''}><title>${b.end === null ? 'waiting for workers' : 'waited for workers'}</title></rect>`);
        continue;
      }
      const color = b.ok ? LANE_COLORS[b.lane % LANE_COLORS.length] : 'var(--bad)';
      parts.push(`<rect x="${cx(b.lane) - 4}" y="${y1}" width="8" height="${h}" rx="4" fill="${color}" opacity=".45" ${b.end === null ? 'class="pulse"' : ''}>
        <title>${b.end === null ? 'working now' : 'turn'}</title></rect>`);
    }
    // rows
    tl.rows.forEach((r, i) => {
      const yy = ys[i];
      if (r.kind === 'tick') return;
      parts.push(`<text class="time" x="6" y="${yy + 4}">${esc(hms(r.ts))}</text>`);
      const isSel = selected && r.ref.type === selected.type && r.ref.id === selected.id;
      parts.push(r.kind === 'arrow' ? arrow(r, yy, cx, laneW, !!isSel) : node(r, yy, cx, laneW, !!isSel));
    });

    return `<div class="scroll"><div style="width:${totalW}px">
      <div class="lanes"><div style="width:${GUTTER}px;flex:none"></div>${heads}</div>
      <svg width="${totalW}" height="${height}" viewBox="0 0 ${totalW} ${height}">
        <defs>${(['neutral', 'ok', 'accent', 'warn', 'error', 'muted'] as Tone[]).map((t) =>
          `<marker id="ah-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="${toneColor(t)}"/></marker>`).join('')}</defs>
        ${parts.join('')}
      </svg></div></div>`;
  }

  function arrow(r: Extract<Row, { kind: 'arrow' }>, y: number, cx: (l: number) => number, laneW: number, sel: boolean) {
    const x1 = cx(r.from), x2 = cx(r.to);
    const dir = x2 >= x1 ? 1 : -1;
    const span = Math.abs(x2 - x1);
    const color = toneColor(r.tone);
    const label = clip(r.label, Math.max(12, Math.floor((span || laneW) / 6.6)));
    const lx = (x1 + x2) / 2;
    return `<g class="hit" data-act="select" data-type="${r.ref.type}" data-id="${r.ref.id}">
      <rect x="${Math.min(x1, x2)}" y="${y - 18}" width="${Math.max(span, 20)}" height="28" fill="transparent"/>
      <line x1="${x1 + dir * 6}" y1="${y}" x2="${x2 - dir * 6}" y2="${y}" stroke="${color}" stroke-width="${sel ? 2.5 : 1.5}"
        ${r.pending ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#ah-${r.tone})"/>
      <circle cx="${x1}" cy="${y}" r="3" fill="${color}"/>
      <text x="${lx}" y="${y - 6}" text-anchor="middle" ${sel ? 'font-weight="600"' : ''}>${esc(label)}${r.pending ? ' (queued)' : ''}</text></g>`;
  }

  function node(r: Extract<Row, { kind: 'node' }>, y: number, cx: (l: number) => number, laneW: number, sel: boolean) {
    const x = cx(r.lane);
    const color = toneColor(r.tone);
    const shape = r.shape === 'diamond'
      ? `<path d="M${x},${y - 7} L${x + 7},${y} L${x},${y + 7} L${x - 7},${y} z" fill="${color}" ${r.tone === 'warn' ? 'class="pulse"' : ''}/>`
      : r.shape === 'square' ? `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2" fill="${color}"/>`
        : `<circle cx="${x}" cy="${y}" r="5" fill="${color}"/>`;
    return `<g class="hit" data-act="select" data-type="${r.ref.type}" data-id="${r.ref.id}">
      <rect x="${x - 10}" y="${y - 12}" width="${laneW * 1.4}" height="24" fill="transparent"/>${shape}
      <text x="${x + 12}" y="${y + 4}" fill="${color}" ${sel ? 'font-weight="600"' : ''}>${esc(clip(r.label, Math.floor((laneW * 1.4) / 6.6)))}</text></g>`;
  }

  // ── details drawer ───────────────────────────────────────────────
  function drawer(d: RunDetailDTO): string {
    if (!selected) return `<div class="drawer sub">Click an arrow, a node or a lane header for details.</div>`;
    const ended = d.run.status === 'ended';
    const close = '<button data-act="close">Close</button>';
    if (selected.type === 'agent') {
      const a = d.agents.find((x) => x.id === selected!.id);
      return a ? `<div class="drawer">${agentDetail(a, ended, close)}</div>` : '';
    }
    if (selected.type === 'gate') {
      const g = d.gates.find((x) => x.id === selected!.id);
      return g ? `<div class="drawer">${gateDetail(g, ended, close)}</div>` : '';
    }
    if (selected.type === 'message') {
      const m = d.messages.find((x) => x.id === selected!.id);
      if (!m) return '';
      return `<div class="drawer"><div class="row"><b class="grow">${esc(m.from ?? 'You')} → ${esc(m.to)} · ${esc(m.kind)}</b>
        <span class="sub">${esc(new Date(m.createdAt).toLocaleString())}${m.deliveredAt ? ` · delivered ${esc(hms(m.deliveredAt))}` : m.state === 'dispatching' ? ' · delivering' : m.state === 'cancelled' ? ' · cancelled' : ' · queued'}${m.attempts > 1 ? ` · ${m.attempts} attempts` : ''}</span>${close}</div>
        <pre>${esc(m.body)}</pre></div>`;
    }
    const e = d.events.find((x) => x.id === selected!.id);
    return e ? `<div class="drawer"><div class="row"><b class="grow">${esc(e.type)}${e.agentId ? ` · ${esc(e.agentId)}` : ''}</b>
      <span class="sub">${esc(new Date(e.createdAt).toLocaleString())}</span>${close}</div><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></div>` : '';
  }

  function gateDetail(g: GateDTO, ended: boolean, close: string): string {
    const title = g.kind === 'plan' ? `Plan #${g.id} from ${esc(g.requestedBy)}` : `Merge ${esc(g.subjectAgent)} into the lead branch (#${g.id})`;
    const actions = g.status === 'pending' && !ended
      ? `<textarea data-draft="gate-${g.id}" placeholder="Comment (optional; sent to the lead)"></textarea>
        <div class="row" style="margin-top:6px"><button class="primary" data-act="approve" data-id="${g.id}">Approve</button>
        <button class="danger" data-act="reject" data-id="${g.id}">Reject</button></div>`
      : `<div class="sub">Decision: <span class="badge b-${esc(g.status)}">${esc(g.status)}</span>${g.comment ? ` — ${esc(g.comment)}` : ''}</div>`;
    const review = g.snapshot ? `<div class="sub">Reviewed worker ${esc(g.snapshot.workerHead.slice(0, 10))} · base ${esc(g.snapshot.mergeBase.slice(0, 10))}</div>
      <div class="files">${g.snapshot.files.map((f) => `<div class="file"><span>${esc(f.status)}</span><span class="path">${f.oldPath ? `${esc(f.oldPath)} → ` : ''}${esc(f.path)}</span>${f.binary
        ? '<span>binary</span>' : `<span class="plus">+${f.additions ?? 0}</span><span class="minus">-${f.deletions ?? 0}</span>`}</div>`).join('')}</div>
      <details data-diff="${g.id}"><summary>View diff${g.snapshot.diffTruncated ? ' (truncated at 200 KB)' : ''}</summary></details>` : '';
    return `<div class="row"><b class="grow">${title}</b>${close}</div><pre>${esc(g.payload)}</pre>${review}${actions}`;
  }

  function agentDetail(a: AgentDTO, ended: boolean, close: string): string {
    const canMsg = !ended && a.status !== 'merged' && a.status !== 'ended';
    return `<div class="row"><b class="grow">${esc(a.id)} <span class="sub">${esc(a.role)} · ${esc(a.provider)}</span>
        <span class="badge b-${esc(a.status)}">${esc(a.status)}</span></b>
        ${a.appSessionId ? `<button data-act="go" data-id="${esc(a.appSessionId)}">Go to session</button>
          <button data-act="newtab" data-id="${esc(a.appSessionId)}">Open ↗</button>` : ''}${close}</div>
      <div class="sub">${esc(a.cwd)}${a.branch ? ` · ${esc(a.branch)}` : ''}</div>
      ${drawerUsageHtml(a.usage)}
      ${a.lastError ? `<div class="err sub">${esc(a.lastError)}</div>` : ''}
      ${a.task ? `<h3>Task</h3><pre>${esc(a.task)}</pre>` : ''}
      ${a.result ? `<h3>Result</h3><pre>${esc(a.result)}</pre>` : ''}
      ${a.status === 'interrupted' ? '<div class="sub">Interrupted by a broker restart. Send it a message to continue in its session, or end it.</div>' : ''}
      ${canMsg ? `<div class="row" style="margin-top:8px"><input class="grow" style="width:auto" data-draft="msg-${esc(a.id)}" placeholder="Message ${esc(a.id)}…">
        <button data-act="msg" data-id="${esc(a.id)}">Send</button></div>` : ''}
      ${canMsg && a.role !== 'lead' && !a.busy ? `<div class="row" style="margin-top:8px"><span class="grow sub">Ending frees its worker slot; it stops receiving messages.</span>
        <button class="danger" data-act="end-agent" data-id="${esc(a.id)}" data-wt="${a.worktreePath ? '1' : ''}">End agent</button></div>` : ''}`;
  }

  // ── events ───────────────────────────────────────────────────────
  const onClick = (ev: Event) => {
    const el = (ev.target as Element).closest<HTMLElement | SVGElement>('[data-act]');
    if (!el || !root.contains(el)) return;
    const ds = (el as HTMLElement).dataset;
    const id = ds.id ?? '';
    switch (ds.act) {
      case 'open-run': selectedRun = id; selected = null; firstPaint = true; void refresh(true); break;
      case 'back': selectedRun = null; selected = null; void refresh(true); break;
      case 'select':
        selected = ds.type === 'agent' ? { type: 'agent', id } : { type: ds.type as Ref['type'], id: Number(id) } as Ref;
        render();
        break;
      case 'close': selected = null; render(); break;
      case 'approve':
      case 'reject': {
        const comment = drafts.get(`gate-${id}`) ?? '';
        el.setAttribute('disabled', '');
        void act(() => api.rpc('POST', `gates/${id}`, { approve: ds.act === 'approve', comment })).then(() => drafts.delete(`gate-${id}`));
        break;
      }
      case 'msg': {
        const body = (drafts.get(`msg-${id}`) ?? '').trim();
        if (!body) return;
        void act(async () => {
          const r = (await api.rpc('POST', `agents/${id}/messages`, { body })) as { note?: string };
          if (r?.note) error = r.note; // shown in the error banner: queued, waiting for a worker slot
        }).then(() => drafts.delete(`msg-${id}`));
        break;
      }
      case 'end': {
        if (!confirm(`End run ${id}? Agents stop receiving messages.`)) return;
        const removeWorktrees = confirm('Also delete the unmerged worktrees of this run? (Branches are kept.)');
        void act(() => api.rpc('POST', `runs/${id}/end`, { removeWorktrees }));
        break;
      }
      case 'end-agent': {
        if (!confirm(`End ${id}? It stops receiving messages and frees its worker slot.`)) return;
        const removeWorktree = ds.wt === '1' && confirm(`Also delete the unmerged worktree of ${id}? (Its branch is kept.)`);
        void act(() => api.rpc('POST', `agents/${id}/end`, { removeWorktree }));
        break;
      }
      case 'setup': {
        const apiKey = (drafts.get('apikey') ?? '').trim();
        if (!apiKey) return;
        void act(async () => {
          const proof = await api.rpc('GET', 'setup/nonce') as { nonce?: string };
          await api.rpc('POST', 'setup', { apiKey, nonce: proof.nonce });
        }).then(() => drafts.delete('apikey'));
        break;
      }
      case 'diagnostics':
        diagnosticsOpen = !diagnosticsOpen;
        diagnostics = null;
        render();
        if (diagnosticsOpen) void api.rpc('GET', 'diagnostics').then((value) => { diagnostics = value; render(); }, (e) => { error = (e as Error).message; render(); });
        break;
      case 'register':
        if (!confirm('Register CoAgent as a user-level MCP server for Claude and Codex?')) return;
        void act(() => api.rpc('POST', 'registration', { action: 'register' }));
        break;
      case 'unregister':
        if (!confirm('Unregister the CoAgent MCP server from Claude and Codex? Active sessions may keep their existing tools until restarted.')) return;
        void act(() => api.rpc('POST', 'registration', { action: 'unregister' }));
        break;
      case 'newtab': window.open(`/session/${encodeURIComponent(id)}`, '_blank', 'noopener'); break;
      case 'go':
        // Navigates the host SPA (React Router listens to popstate).
        history.pushState({}, '', `/session/${encodeURIComponent(id)}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
        break;
    }
  };
  root.addEventListener('click', onClick);
  const onToggle = (ev: Event) => {
    const el = ev.target as HTMLDetailsElement;
    if (!el.matches('details[data-diff]')) return;
    const id = Number(el.dataset.diff);
    if (!el.open) { openDiffs.delete(id); return; }
    openDiffs.add(id);
    if (el.dataset.loaded) return;
    el.dataset.loaded = 'true';
    const gate = state?.current?.gates.find((g) => g.id === id);
    void mountDiff(el, api.rpc.bind(api), id, { dark: api.context.theme === 'dark', snapshotFiles: gate?.snapshot?.files })
      .then((ok) => { if (!ok) delete el.dataset.loaded; });
  };
  root.addEventListener('toggle', onToggle, true);

  const onResize = () => render();
  window.addEventListener('resize', onResize);
  const unsub = api.onContextChange(() => { applyTheme(); selectedRun = null; selected = null; firstPaint = true; void refresh(true); });
  const timer = window.setInterval(() => { void refresh(); }, POLL_MS);
  void refresh(true);

  teardown = () => {
    window.clearInterval(timer);
    window.removeEventListener('resize', onResize);
    unsub();
    root.removeEventListener('click', onClick);
    root.removeEventListener('toggle', onToggle, true);
    container.innerHTML = '';
  };
}

export function unmount() {
  teardown?.();
  teardown = null;
}

/** CloudCLI plugin tool-renderer slot: draws coagent tool calls in chat (manifest `toolRenderers`). */
export { renderTool } from './toolCards.js';
