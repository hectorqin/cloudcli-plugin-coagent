import { describe, expect, it } from 'vitest';
import { blocksHtml, diffCss, diffPanelHtml, scopeCss } from '../src/frontend/diffView.js';

const DIFF = `diff --git a/src/<script>.ts b/src/<script>.ts
index 1111111..2222222 100644
--- a/src/<script>.ts
+++ b/src/<script>.ts
@@ -1,3 +1,4 @@
 const a = "<b>bold</b>";
-const b = "<img src=x onerror=alert(1)>";
+const b = '<script>alert("x")</script>';
+const c = 3;
 export {};
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..3333333
Binary files /dev/null and b/logo.png differ
`;
const base = { layout: 'unified' as const, dark: false, truncated: false };

describe('diff panel', () => {
  it('escapes HTML-looking lines and file names (diff2html does, and so does our header)', () => {
    const html = diffPanelHtml(DIFF, base);
    expect(html).not.toMatch(/<script|<img|<b>bold/);
    expect(html).toContain('&lt;b&gt;bold&lt;&#x2F;b&gt;'); // context line
    expect(html).toMatch(/&lt;(<ins>)?script/); // changed lines are split by word-level <ins>/<del> marks
    expect(html).toMatch(/&lt;(<del>)?img/);
    expect(html).toContain('src/&#60;script&#62;.ts'); // file list row
  });

  it('shows a GitHub-style header: totals, per-file counts with a bar, layout toggle', () => {
    const html = diffPanelHtml(DIFF, base);
    expect(html).toContain('2 files changed');
    expect(html).toMatch(/cad-plus">\+2<[\s\S]*cad-minus">−1</);
    expect(html).toContain('data-cad-layout="unified" aria-pressed="true"');
    expect(html).toContain('data-cad-layout="split" aria-pressed="false"');
    expect(html).toContain('d2h-file-collapse'); // each file can be collapsed ("Viewed")
    expect(html).toContain('d2h-code-linenumber');
    expect(diffPanelHtml(DIFF, { ...base, layout: 'split' })).toContain('d2h-files-diff');
  });

  it('marks binary files with a notice instead of a diff', () => {
    const html = diffPanelHtml(DIFF, base);
    expect(html).toContain('Binary file: contents are not shown.');
    expect(html).toContain('<span class="cad-tag">binary</span>');
  });

  it('explains a truncated diff and lists snapshot files it does not contain', () => {
    const html = diffPanelHtml(DIFF, { ...base, truncated: true, snapshotFiles: [
      { path: 'src/<script>.ts', oldPath: null, status: 'M', additions: 2, deletions: 1, binary: false },
      { path: 'later.ts', oldPath: null, status: 'A', additions: 9, deletions: 0, binary: false },
    ] });
    expect(html).toContain('Diff truncated at 200 KB.');
    expect(html).toContain('1 file is not shown at all');
    expect(html).toMatch(/later\.ts<\/span>\s*<span class="cad-tag">not shown/);
    expect(html).toContain('3 files changed');
  });

  it('follows the theme through diff2html colorScheme', () => {
    expect(diffPanelHtml(DIFF, { ...base, dark: true })).toMatch(/class="cad cad-dark"[\s\S]*d2h-dark-color-scheme/);
    expect(diffPanelHtml(DIFF, base)).toContain('d2h-light-color-scheme');
  });

  it('draws the five-square bar', () => {
    expect(blocksHtml(3, 1)).toBe('<span class="cad-blocks" aria-hidden="true"><i class="a"></i><i class="a"></i><i class="a"></i><i class="d"></i><i class=""></i></span>');
    expect(blocksHtml(30, 10).match(/class="a"/g)).toHaveLength(4);
    expect(blocksHtml(0, 0)).not.toMatch(/class="[ad]"/);
  });
});

describe('scoped css', () => {
  it('prefixes every rule, including media queries and :root', () => {
    expect(scopeCss(':host,:root{--x:1}.a,.b .c{color:red}@media (x){.d{e:f}}/* c */', '.s'))
      .toBe('.s{--x:1}.s .a,.s .b .c{color:red}@media (x){.s .d{e:f}}');
  });

  it('leaks nothing from diff2html or highlight.js into the page', () => {
    const css = diffCss();
    expect(css.length).toBeGreaterThan(10_000);
    const selectors = css.replace(/@media[^{]*\{/g, '').replace(/\{[^{}]*\}/g, '\n').split('\n').flatMap((l) => l.split(','))
      .map((s) => s.replace(/^[\s}]+/, '').trim()).filter(Boolean);
    expect(selectors.filter((s) => !s.startsWith('.cad'))).toEqual([]);
  });
});
