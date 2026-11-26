import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [{
    // `?raw` stylesheets as text, like the esbuild plugin in build.mjs (Vitest otherwise stubs CSS to '').
    name: 'raw-css', enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith('.css?raw')) return null;
      const r = await this.resolve(source.slice(0, -4), importer, { skipSelf: true });
      return r ? `\0raw:${r.id}.txt` : null; // not `.css`: Vite's CSS plugin would stub it again
    },
    async load(id) {
      if (!id.startsWith('\0raw:')) return null;
      return `export default ${JSON.stringify(await readFile(id.slice(5, -4), 'utf8'))};`;
    },
  }],
  // diff2html's ESM build (lib-esm) uses extensionless imports in a CommonJS package: let Vite transform it.
  test: { server: { deps: { inline: ['diff2html'] } } },
});
