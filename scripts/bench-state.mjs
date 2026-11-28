#!/usr/bin/env node
// Measures the store reads behind GET /state for one run on a synthetic 10k-message / 2k-event database, without the
// v7 hot-path indexes ("before") and with them ("after"). Not part of `npm test`: timings are machine dependent.
//
//   node scripts/bench-state.mjs [messages=10000] [events=2000] [iterations=20]
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [messages = 10_000, events = 2_000, iterations = 20] = process.argv.slice(2).map(Number);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-bench-'));
try {
  const bundle = path.join(tmp, 'store.mjs');
  await build({ entryPoints: [path.join(root, 'src/broker/store.ts')], bundle: true, platform: 'node', format: 'esm',
    outfile: bundle, logLevel: 'silent', external: ['node:*'] });
  const { Store } = await import(pathToFileURL(bundle).href);
  const { DatabaseSync } = await import('node:sqlite');

  const file = path.join(tmp, 'coagent.db');
  const store = new Store(file);
  store.transaction(() => {
    // Noise from other runs, so a run_id filter without an index has to skip rows.
    for (let r = 0; r < 5; r++) {
      const run = `r${r}`;
      store.createRun(run, `lead${r}`, '/repo');
      store.createAgent({ id: `lead${r}`, runId: run, role: 'lead', provider: 'claude', cwd: '/repo', status: 'lead' });
      for (let w = 0; w < 4; w++) {
        store.createAgent({ id: `w${r}-${w}`, runId: run, role: 'coder', provider: 'codex', cwd: '/repo', status: 'idle' });
        for (let t = 0; t < 25; t++) store.finishTurn(store.startTurn(`w${r}-${w}`, run), 'ok');
      }
      for (let g = 0; g < 20; g++) store.addGate(run, 'merge', `lead${r}`, `w${r}-${g % 4}`, 'p');
      for (let i = 0; i < messages / 5; i++) store.addMessage(run, `lead${r}`, `w${r}-${i % 4}`, 'message', `m${i}`);
      for (let i = 0; i < events / 5; i++) store.addEvent(run, `lead${r}`, 'turn_end', { i });
    }
  });
  const state = () => {
    store.runSummaries();
    store.run('r2'); store.agents('r2'); store.messages('r2'); store.gates('r2'); store.events('r2');
    store.expiredDispatches(Date.now()); store.agentsWithUndelivered();
  };
  const measure = () => {
    state();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) state();
    return (performance.now() - start) / iterations;
  };
  const after = measure();
  const raw = new DatabaseSync(file);
  const hot = ['agents_run_created', 'agents_app_session', 'messages_run_id', 'messages_delivery_id', 'messages_gate_id',
    'gates_run_id', 'gates_pending_subject', 'turns_run_agent_id'];
  for (const index of hot) raw.exec(`DROP INDEX IF EXISTS ${index}`);
  raw.close();
  const before = measure();
  store.close();
  console.log(`state reads (${messages} messages, ${events} events, 5 runs, mean of ${iterations}): `
    + `${before.toFixed(2)} ms before indexes, ${after.toFixed(2)} ms after`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
