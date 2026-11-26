// @vitest-environment happy-dom
import hljs from 'highlight.js/lib/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountDiff } from '../src/frontend/diffView.js';

const file = (name: string, before: string, after: string) => `diff --git a/${name} b/${name}
index 1111111..2222222 100644
--- a/${name}
+++ b/${name}
@@ -1,2 +1,2 @@
 keep
-${before}
+${after}
`;
// Unregistered (.txt, .cpp, .toml), extensionless and registered (.ts) files together.
const DIFF = file('notes.txt', 'old note', 'new note') + file('Makefile', 'all: old', 'all: new')
  + file('main.cpp', 'int a = 1;', 'int a = 2;') + file('Cargo.toml', 'x = 1', 'x = 2') + file('src/a.ts', 'const a = 1;', 'const a = 2;');

let gate = 100;
async function mount(diff = DIFF) {
  document.body.innerHTML = '<details open></details>';
  const target = document.querySelector('details')!;
  const ok = await mountDiff(target, async () => ({ diff, truncated: false }), gate++, { dark: false });
  return { ok, target };
}

afterEach(() => vi.restoreAllMocks());

describe('diff panel in the DOM', () => {
  it('highlights registered languages and renders every other file as plain text', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { ok, target } = await mount();
    expect(ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(target.querySelectorAll('.d2h-file-wrapper')).toHaveLength(5);
    expect(target.textContent).toContain('new note');
    expect(target.textContent).toContain('all: new');
    const line = (lang: string) => target.querySelector(`[data-lang="${lang}"] .d2h-ins .d2h-code-line-ctn`)!;
    expect(line('ts').classList.contains('typescript')).toBe(true);
    expect(line('ts').innerHTML).toContain('hljs-keyword');
    for (const lang of ['txt', '', 'cpp', 'toml']) expect(line(lang).classList.contains('plaintext')).toBe(true);
  });

  it('wires collapsing and the layout toggle', async () => {
    const { target } = await mount();
    const first = target.querySelector('.d2h-file-wrapper')!;
    first.querySelector<HTMLInputElement>('.d2h-file-collapse-input')!.click();
    expect(first.querySelector('.d2h-file-diff')!.classList.contains('d2h-d-none')).toBe(true);
    target.querySelector<HTMLButtonElement>('[data-cad-layout="split"]')!.click();
    expect(target.querySelector('.d2h-files-diff')).not.toBeNull();
    target.querySelector<HTMLButtonElement>('[data-cad-layout="unified"]')!.click();
    expect(target.querySelector('.d2h-files-diff')).toBeNull();
  });

  it('falls back to an unhighlighted diff when the highlighter throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(hljs, 'highlight').mockImplementation(() => { throw new Error('Unknown language: plaintext'); });
    const { ok, target } = await mount();
    expect(ok).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(target.querySelector('.hljs')).toBeNull();
    expect(target.textContent).toContain('const a = 2;');
    // Toggles are still wired after the fallback.
    const first = target.querySelector('.d2h-file-wrapper')!;
    first.querySelector<HTMLInputElement>('.d2h-file-collapse-input')!.click();
    expect(first.querySelector('.d2h-file-diff')!.classList.contains('d2h-d-none')).toBe(true);
  });
});
