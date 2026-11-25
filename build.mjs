import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: watch ? 'inline' : false, minify: !watch, logLevel: 'info' };

const targets = [
  // Tab UI: the host imports this single file from a Blob URL, so it must be self-contained.
  { ...common, entryPoints: ['src/frontend/index.ts'], outfile: 'dist/index.js', format: 'esm', platform: 'browser', target: 'es2022' },
  // Broker: spawned by CloudCLI as `node dist/server.js`.
  { ...common, entryPoints: ['src/broker/server.ts'], outfile: 'dist/server.js', format: 'esm', platform: 'node', target: 'node22', packages: 'bundle' },
  // MCP shim: spawned by claude/codex as `node dist/mcp-shim.js`.
  { ...common, entryPoints: ['src/shim/mcp-shim.ts'], outfile: 'dist/mcp-shim.js', format: 'esm', platform: 'node', target: 'node22', packages: 'bundle',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } },
];

if (watch) {
  for (const t of targets) (await esbuild.context(t)).watch();
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
