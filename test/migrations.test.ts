import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, pendingMigrations, SCHEMA_VERSION, schemaVersion, Store } from '../src/broker/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-migrations-'));
  dirs.push(dir);
  return { dir, file: path.join(dir, 'coagent.db') };
};

const HOT = ['agents_run_created', 'agents_app_session', 'messages_run_id', 'messages_delivery_lease_id',
  'gates_run_id', 'gates_pending_subject', 'turns_run_agent_id'];
const SNAPSHOT_COLUMNS = ['worker_head', 'lead_head', 'merge_base', 'diff_stat', 'name_status', 'snapshot_files', 'unified_diff', 'diff_truncated'];

function historicalShape(file: string, version: number) {
  new Store(file).close();
  const db = new DatabaseSync(file);
  for (const index of HOT) db.exec(`DROP INDEX IF EXISTS ${index}`);
  db.exec('PRAGMA user_version = 0');
  if (version < 6) for (const column of ['resume_at', 'pause_reason', 'pause_nudge']) db.exec(`ALTER TABLE agents DROP COLUMN ${column}`);
  if (version < 5) db.exec('ALTER TABLE runs DROP COLUMN ending_at');
  if (version < 4) db.exec('DROP TABLE turns');
  if (version < 3) for (const column of SNAPSHOT_COLUMNS) db.exec(`ALTER TABLE gates DROP COLUMN ${column}`);
  if (version < 2) {
    db.exec('DROP INDEX IF EXISTS messages_delivery; DROP INDEX IF EXISTS messages_delivery_lease_id');
    for (const column of ['gate_id', 'delivery_state', 'attempts', 'lease_until']) db.exec(`ALTER TABLE messages DROP COLUMN ${column}`);
    db.exec('CREATE INDEX IF NOT EXISTS messages_inbox ON messages(to_agent, delivered_at)');
  }
  db.prepare('INSERT INTO kv(k,v) VALUES (?,?)').run('shape', String(version));
  db.close();
}

describe('versioned schema migrations', () => {
  it('has an ordered, gap-free, append-only ledger', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
    expect(MIGRATIONS.every((m) => m.description.length > 5)).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 6])('upgrades the historical v%i shape, preserves data, and is idempotent', (version) => {
    const { dir, file } = tempFile();
    historicalShape(file, version);
    const before = new DatabaseSync(file, { readOnly: true });
    expect(schemaVersion(before)).toBe(version);
    before.close();

    new Store(file).close();
    const db = new DatabaseSync(file, { readOnly: true });
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT v FROM kv WHERE k='shape'").get()).toEqual({ v: String(version) });
    expect(pendingMigrations(db)).toEqual([]);
    db.close();
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(1);
    new Store(file).close();
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(1);
  });

  it('backs up only when the ledger version changes, not for same-version additive repair', () => {
    const { dir, file } = tempFile();
    new Store(file).close();
    const db = new DatabaseSync(file);
    db.exec('DROP INDEX messages_run_id');
    db.close();
    new Store(file).close();
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
  });

  it('uses every hot-path index in representative query plans', () => {
    const { file } = tempFile();
    new Store(file).close();
    const db = new DatabaseSync(file);
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join('\n');
    const cases: [string, string][] = [
      ["SELECT * FROM agents WHERE run_id='r' ORDER BY created_at", 'agents_run_created'],
      ["SELECT * FROM agents WHERE app_session_id='a'", 'agents_app_session'],
      ["SELECT * FROM messages WHERE run_id='r' ORDER BY id", 'messages_run_id'],
      ["SELECT * FROM messages WHERE delivery_state='dispatching' AND lease_until < 1 ORDER BY id", 'messages_delivery_lease_id'],
      ["SELECT * FROM gates WHERE run_id='r' ORDER BY id", 'gates_run_id'],
      ["SELECT * FROM gates WHERE run_id='r' AND kind='merge' AND status='pending' AND subject_agent='a'", 'gates_pending_subject'],
      ["SELECT * FROM turns WHERE run_id='r' AND agent_id='a' ORDER BY id", 'turns_run_agent_id'],
      ["SELECT * FROM events WHERE run_id='r' ORDER BY id", 'events_run'],
    ];
    for (const [sql, index] of cases) expect(plan(sql), sql).toContain(index);
    db.close();
  });

  it('measures state-history reads on 10k messages and 2k events before and after indexes', () => {
    const { file } = tempFile();
    const store = new Store(file);
    store.createRun('r', 'lead', '/repo');
    store.createAgent({ id: 'lead', runId: 'r', role: 'lead', provider: 'claude', cwd: '/repo', status: 'lead' });
    store.transaction(() => {
      for (let i = 0; i < 10_000; i++) store.addMessage('r', 'lead', 'lead', 'message', `m${i}`);
      for (let i = 0; i < 2_000; i++) store.addEvent('r', 'lead', 'turn_end', { i });
    });
    store.close();
    const db = new DatabaseSync(file);
    const read = () => {
      db.prepare("SELECT * FROM messages WHERE run_id='r' ORDER BY id").all();
      db.prepare("SELECT * FROM events WHERE run_id='r' ORDER BY id").all();
    };
    const measure = () => {
      const start = performance.now();
      for (let i = 0; i < 5; i++) read();
      return (performance.now() - start) / 5;
    };
    db.exec('DROP INDEX messages_run_id');
    read();
    const before = measure();
    db.exec('CREATE INDEX messages_run_id ON messages(run_id, id)');
    read();
    const after = measure();
    console.info(`state latency (10k messages/2k events): ${before.toFixed(2)}ms before, ${after.toFixed(2)}ms after`);
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(0);
    db.close();
  });
});
