/**
 * GitHub-style merge diff panel (tab gate drawer and merge approval card), rendered with diff2html and highlighted
 * with a small highlight.js build. Everything diff2html does not render is escaped here; diff2html escapes file
 * names and line content itself (covered by test/diffView.test.ts).
 */
import { html as d2hHtml, parse as d2hParse } from 'diff2html';
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui-base.js';
import { ColorSchemeType, type DiffFile } from 'diff2html/lib-esm/types.js';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import D2H_CSS from 'diff2html/bundles/css/diff2html.min.css?raw';
import HLJS_LIGHT from 'highlight.js/styles/github.min.css?raw';
import HLJS_DARK from 'highlight.js/styles/github-dark.min.css?raw';
import type { MergeSnapshotFile } from '../shared/protocol.js';

export type DiffLayout = 'unified' | 'split';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LAYOUT_KEY = 'coagent.diffLayout';
/** Below this width Split is unreadable; it is the default above it. */
const SPLIT_MIN_WIDTH = 820;
const SCOPE = '.cad';

let hljsReady = false;
function highlighter() {
  if (!hljsReady) {
    hljsReady = true;
    for (const [name, lang] of Object.entries({ bash, css, go, javascript, json, markdown, plaintext, python, rust, typescript, xml, yaml })) {
      hljs.registerLanguage(name, lang);
    }
    hljs.registerAliases(['sh', 'zsh'], { languageName: 'bash' });
    hljs.registerAliases(['html', 'htm', 'svg'], { languageName: 'xml' });
    hljs.registerAliases(['yml'], { languageName: 'yaml' });
  }
  return hljs;
}

// ── CSS ─────────────────────────────────────────────────────────────
/** Splits a selector list on top-level commas. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Prefixes every rule of a (minified) stylesheet with `scope` so nothing leaks into the host page. `:root`/`:host`
 * become the scope itself; @media blocks are scoped recursively; comments are dropped.
 */
export function scopeCss(input: string, scope: string): string {
  const src = input.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    // Find the matching close brace.
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
    const body = src.slice(open + 1, j - 1);
    if (head.startsWith('@media') || head.startsWith('@supports')) out += `${head}{${scopeCss(body, scope)}}`;
    else if (head.startsWith('@')) out += `${head}{${body}}`;
    else {
      const sels = splitSelectors(head).map((s) => (/^(:root|:host)$/.test(s) ? scope : `${scope} ${s}`));
      out += `${[...new Set(sels)].join(',')}{${body}}`;
    }
    i = j;
  }
  return out;
}

const OWN_CSS = `
${SCOPE}{--cad-fg:var(--fg,#1f2328);--cad-muted:var(--muted,#656d76);--cad-line:var(--line,#d0d7de);--cad-card:var(--card,#f6f8fa);--cad-bg:var(--bg,#fff);
  --cad-ok:var(--ok,#1a7f37);--cad-bad:var(--bad,#cf222e);--cad-accent:var(--accent,#0969da);
  --d2h-bg-color:var(--cad-bg);--d2h-border-color:var(--cad-line);--d2h-file-header-bg-color:var(--cad-card);--d2h-file-header-border-color:var(--cad-line);
  --d2h-line-border-color:var(--cad-line);--d2h-ins-bg-color:#e6ffec;--d2h-ins-highlight-bg-color:#abf2bc;--d2h-ins-border-color:#4ac26b66;--d2h-ins-label-color:#1a7f37;
  --d2h-del-bg-color:#ffebe9;--d2h-del-highlight-bg-color:#ff818266;--d2h-del-border-color:#ff818266;--d2h-del-label-color:#cf222e;
  --d2h-change-del-color:#ffebe9;--d2h-change-ins-color:#e6ffec;--d2h-dark-change-del-color:rgba(248,81,73,.1);--d2h-dark-change-ins-color:rgba(46,160,67,.15);
  --d2h-info-bg-color:#ddf4ff;--d2h-info-border-color:#54aeff66;--d2h-empty-placeholder-bg-color:var(--cad-card);
  --d2h-dark-bg-color:var(--cad-bg);--d2h-dark-border-color:var(--cad-line);--d2h-dark-file-header-bg-color:var(--cad-card);--d2h-dark-file-header-border-color:var(--cad-line);
  color-scheme:light;color:var(--cad-fg);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin-top:6px}
${SCOPE}.cad-dark{--cad-fg:var(--fg,#e6edf3);--cad-muted:var(--muted,#8d96a0);--cad-line:var(--line,#30363d);--cad-card:var(--card,#161b22);--cad-bg:var(--bg,#0d1117);
  --cad-ok:var(--ok,#3fb950);--cad-bad:var(--bad,#f85149);--cad-accent:var(--accent,#4493f8);color-scheme:dark}
${SCOPE} .cad-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
${SCOPE} .cad-sum{flex:1;min-width:0}${SCOPE} .cad-sum b{font-weight:600}
${SCOPE} .cad-plus{color:var(--cad-ok);font-weight:600}${SCOPE} .cad-minus{color:var(--cad-bad);font-weight:600}
${SCOPE} .cad-seg{display:inline-flex;border:1px solid var(--cad-line);border-radius:6px;overflow:hidden}
${SCOPE} .cad-seg button{font:inherit;font-size:12px;padding:2px 10px;border:0;margin:0;border-radius:0;background:transparent;color:var(--cad-fg);cursor:pointer}
${SCOPE} .cad-seg button+button{border-left:1px solid var(--cad-line)}
${SCOPE} .cad-seg button[aria-pressed="true"]{background:var(--cad-accent);color:#fff}
${SCOPE} .cad-files{border:1px solid var(--cad-line);border-radius:6px;overflow:hidden;margin-bottom:8px}
${SCOPE} .cad-f{display:flex;gap:8px;align-items:center;padding:3px 8px;border-top:1px solid var(--cad-line);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}
${SCOPE} .cad-f:first-child{border-top:0}${SCOPE} .cad-f:hover{background:var(--cad-card)}
${SCOPE} .cad-f .st{width:1.2em;color:var(--cad-muted)}${SCOPE} .cad-f .path{flex:1;min-width:0;overflow-wrap:anywhere}
${SCOPE} .cad-f .n{white-space:nowrap;font-variant-numeric:tabular-nums}${SCOPE} .cad-f.missing{cursor:default;color:var(--cad-muted)}
${SCOPE} .cad-blocks{display:inline-flex;gap:1px}${SCOPE} .cad-blocks i{display:inline-block;width:8px;height:8px;border-radius:1px;background:var(--cad-line)}
${SCOPE} .cad-blocks i.a{background:var(--cad-ok)}${SCOPE} .cad-blocks i.d{background:var(--cad-bad)}
${SCOPE} .cad-tag{font:11px/16px system-ui,sans-serif;padding:0 6px;border:1px solid var(--cad-line);border-radius:999px;color:var(--cad-muted)}
${SCOPE} .cad-notice{padding:6px 10px;margin-bottom:8px;border:1px solid var(--cad-line);border-left:3px solid var(--warn,#9a6700);border-radius:6px;background:var(--cad-card);font-size:12px}
${SCOPE} .cad-file-notice{padding:10px 12px;color:var(--cad-muted);font-size:12px}
${SCOPE} .d2h-wrapper{margin:0}${SCOPE} .d2h-file-wrapper{border-color:var(--cad-line);border-radius:6px;margin-bottom:10px}
${SCOPE} .d2h-file-header{font-family:inherit;height:auto;min-height:32px;padding:4px 10px;align-items:center}
${SCOPE} .d2h-file-name-wrapper{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}
${SCOPE} .d2h-file-collapse{font-size:11px}
${SCOPE} .d2h-code-line,${SCOPE} .d2h-code-side-line,${SCOPE} .d2h-code-linenumber,${SCOPE} .d2h-code-side-linenumber{font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace}
${SCOPE} .hljs{background:transparent!important;padding:0}
`;

let cssText: string | null = null;
/** The full panel stylesheet: diff2html + light/dark highlight themes, all scoped to `.cad`. */
export function diffCss(): string {
  cssText ??= scopeCss(D2H_CSS, SCOPE) + scopeCss(HLJS_LIGHT, SCOPE) + scopeCss(HLJS_DARK, `${SCOPE}.cad-dark`) + OWN_CSS;
  return cssText;
}
export function ensureDiffStyle() {
  if (typeof document === 'undefined' || document.getElementById('coagent-diff-style')) return;
  const el = document.createElement('style');
  el.id = 'coagent-diff-style';
  el.textContent = diffCss();
  document.head.append(el);
}

// ── markup ──────────────────────────────────────────────────────────
const fileName = (f: DiffFile) => (f.newName === '/dev/null' ? f.oldName : f.newName);
const filePath = (f: DiffFile) => (f.isRename && f.oldName !== f.newName ? `${f.oldName} → ${f.newName}` : fileName(f));
const fileStatus = (f: DiffFile) => (f.isNew ? 'A' : f.isDeleted ? 'D' : f.isRename ? 'R' : 'M');

/** GitHub's five-square change bar. */
export function blocksHtml(additions: number, deletions: number): string {
  const total = additions + deletions;
  const filled = total === 0 ? 0 : Math.min(5, total);
  const add = total === 0 ? 0 : Math.round((additions / total) * filled);
  const cells = Array.from({ length: 5 }, (_, i) => (i < add ? 'a' : i < filled ? 'd' : ''));
  return `<span class="cad-blocks" aria-hidden="true">${cells.map((c) => `<i class="${c}"></i>`).join('')}</span>`;
}

export interface DiffPanelOptions {
  layout: DiffLayout;
  dark: boolean;
  truncated: boolean;
  /** Files of the merge snapshot: the ones absent from a truncated diff are listed as not shown. */
  snapshotFiles?: MergeSnapshotFile[];
}

/** Pure markup of the whole panel (header, file list, notices, per-file diff2html output). */
export function diffPanelHtml(diff: string, o: DiffPanelOptions): string {
  const files = d2hParse(diff);
  const config = {
    outputFormat: o.layout === 'split' ? 'side-by-side' : 'line-by-line',
    drawFileList: false,
    colorScheme: o.dark ? ColorSchemeType.DARK : ColorSchemeType.LIGHT,
    matching: 'lines',
  } as const;
  const shown = new Set(files.flatMap((f) => [f.newName, f.oldName]));
  const missing = (o.snapshotFiles ?? []).filter((f) => !shown.has(f.path));
  const adds = files.reduce((n, f) => n + f.addedLines, 0);
  const dels = files.reduce((n, f) => n + f.deletedLines, 0);
  const total = files.length + missing.length;

  const seg = (['unified', 'split'] as const).map((l) =>
    `<button type="button" data-cad-layout="${l}" aria-pressed="${o.layout === l}">${l === 'split' ? 'Split' : 'Unified'}</button>`).join('');
  const bar = `<div class="cad-bar"><span class="cad-sum"><b>${total} file${total === 1 ? '' : 's'} changed</b>
    <span class="cad-plus">+${adds}</span> <span class="cad-minus">−${dels}</span></span><span class="cad-seg" role="group" aria-label="Diff layout">${seg}</span></div>`;

  const rows = files.map((f, i) => `<div class="cad-f" data-cad-file="${i}" title="Jump to file"><span class="st">${fileStatus(f)}</span>
      <span class="path">${esc(filePath(f))}</span>${f.isBinary ? '<span class="cad-tag">binary</span>'
        : `<span class="n"><span class="cad-plus">+${f.addedLines}</span> <span class="cad-minus">−${f.deletedLines}</span></span>${blocksHtml(f.addedLines, f.deletedLines)}`}</div>`)
    .concat(missing.map((f) => `<div class="cad-f missing"><span class="st">${esc(f.status)}</span><span class="path">${f.oldPath ? `${esc(f.oldPath)} → ` : ''}${esc(f.path)}</span>
      <span class="cad-tag">not shown</span></div>`));
  const list = rows.length ? `<div class="cad-files">${rows.join('')}</div>` : '';

  const notices = [
    o.truncated ? `<div class="cad-notice"><b>Diff truncated at 200 KB.</b> The last file shown may be cut off${missing.length
      ? `, and ${missing.length} file${missing.length === 1 ? ' is' : 's are'} not shown at all` : ''}. Review the full change on the worker branch.</div>` : '',
    !files.length && !o.truncated ? '<div class="cad-notice">No textual changes in this diff.</div>' : '',
  ].join('');

  const body = files.map((f, i) => {
    if (!f.isBinary) return `<div class="cad-file" data-cad-i="${i}">${d2hHtml([f], config)}</div>`;
    // A binary file has nothing diff2html could show: our own header plus a plain notice.
    const scheme = o.dark ? 'd2h-dark-color-scheme' : 'd2h-light-color-scheme';
    return `<div class="cad-file" data-cad-i="${i}"><div class="d2h-wrapper ${scheme}"><div class="d2h-file-wrapper ${scheme}">
      <div class="d2h-file-header ${scheme}"><span class="d2h-file-name-wrapper"><span class="d2h-file-name">${esc(filePath(f))}</span></span>
      <span class="cad-tag">binary</span></div><div class="cad-file-notice">Binary file: contents are not shown.</div></div></div></div>`;
  }).join('');

  return `<div class="cad${o.dark ? ' cad-dark' : ''}">${bar}${notices}${list}${body}</div>`;
}

// ── DOM ─────────────────────────────────────────────────────────────
export function preferredLayout(width: number): DiffLayout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    if (v === 'split' || v === 'unified') return v;
  } catch { /* storage unavailable */ }
  return width >= SPLIT_MIN_WIDTH ? 'split' : 'unified';
}
function rememberLayout(layout: DiffLayout) {
  try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* storage unavailable */ }
}

type Rpc = (method: string, path: string) => Promise<unknown>;
interface DiffData { diff: string; truncated: boolean }
// Merge snapshots are immutable, so a gate's diff is fetched once per page (bounded).
const diffCache = new Map<number, Promise<DiffData>>();
export function loadDiff(rpc: Rpc, gateId: number): Promise<DiffData> {
  let p = diffCache.get(gateId);
  if (!p) {
    p = rpc('GET', `gates/${gateId}/diff`).then((raw) => raw as DiffData);
    p.catch(() => diffCache.delete(gateId));
    diffCache.set(gateId, p);
    while (diffCache.size > 12) diffCache.delete(diffCache.keys().next().value!);
  }
  return p;
}

/**
 * Loads and draws the diff of merge gate `gateId` into `target` (a <details> opened by the user), with highlighting,
 * collapsible files and the Unified/Split toggle.
 */
export function mountDiff(target: HTMLElement, rpc: Rpc, gateId: number, opts: { dark: boolean; snapshotFiles?: MergeSnapshotFile[] }) {
  ensureDiffStyle();
  const host = document.createElement('div');
  host.className = 'cad-host';
  host.textContent = 'Loading diff…';
  target.append(host);
  let layout = preferredLayout(target.clientWidth || host.clientWidth);
  let data: DiffData | null = null;

  const draw = () => {
    if (!data) return;
    const d = data;
    const render = () => {
      host.innerHTML = diffPanelHtml(d.diff, { layout, dark: opts.dark, truncated: d.truncated, snapshotFiles: opts.snapshotFiles });
      return new Diff2HtmlUI(host, undefined, { highlight: true, synchronisedScroll: true, fileContentToggle: true }, highlighter());
    };
    let ui = render();
    try {
      ui.highlightCode();
    } catch (e) {
      // Highlighting is a nicety: on any highlighter error, show the same diff without it (re-rendered, so no line is
      // left half-highlighted).
      console.warn('[coagent] diff highlighting failed; showing it unhighlighted', e);
      ui = render();
    }
    ui.synchronisedScroll();
    ui.fileContentToggle();
  };
  host.addEventListener('click', (ev) => {
    const t = ev.target as Element;
    const btn = t.closest<HTMLElement>('[data-cad-layout]');
    if (btn) {
      const next = btn.dataset.cadLayout as DiffLayout;
      if (next !== layout) { layout = next; rememberLayout(next); draw(); }
      return;
    }
    const row = t.closest<HTMLElement>('[data-cad-file]');
    if (row) {
      host.querySelector(`[data-cad-i="${row.dataset.cadFile}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    // Clicking a file's name collapses or expands it, like the "Viewed" box.
    if (t.closest('.d2h-file-name-wrapper')) {
      t.closest('.d2h-file-header')?.querySelector<HTMLInputElement>('.d2h-file-collapse-input')?.click();
    }
  });

  return loadDiff(rpc, gateId).then((d) => {
    data = d;
    try {
      draw();
      return true;
    } catch (e) {
      host.textContent = `Could not render diff: ${(e as Error).message}`;
      host.dataset.failed = 'true';
      return false;
    }
  }, (e) => {
    host.textContent = `Could not load diff: ${(e as Error).message}`;
    host.dataset.failed = 'true';
    return false;
  });
}
