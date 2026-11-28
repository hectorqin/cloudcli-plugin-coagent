import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, pendingMigrations, SCHEMA_VERSION, schemaVersion, Store, type VersionedMigration } from '../src/broker/store.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-migrations-'));
  dirs.push(dir);
  return { dir, file: path.join(dir, 'coagent.db') };
};

const HOT = ['agents_run_created', 'agents_app_session', 'messages_run_id', 'messages_delivery_id', 'messages_gate_id',
  'gates_run_id', 'gates_pending_subject', 'turns_run_agent_id'];
const SNAPSHOT_COLUMNS = ['worker_head', 'lead_head', 'merge_base', 'diff_stat', 'name_status', 'snapshot_files', 'unified_diff', 'diff_truncated'];

const userVersion = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const schemaSql = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const version = userVersion(db);
  db.close();
  return { version, rows };
};

/** A pre-ledger database (user_version 0) in the shape coagent created at historical version `version`. */
function historicalShape(file: string, version: number) {
  new Store(file).close();
  const db = new DatabaseSync(file);
  for (const index of HOT) db.exec(`DROP INDEX IF EXISTS ${index}`);
  db.exec('PRAGMA user_version = 0');
  if (version < 6) for (const column of ['resume_at', 'pause_reason', 'pause_nudge']) db.exec(`ALTER TABLE agents DROP COLUMN ${column}`);
  if (version < 5) db.exec('ALTER TABLE runs DROP COLUMN ending_at');
  if (version < 4) db.exec('DROP TABLE turns');
  else db.exec('CREATE INDEX turns_run ON turns(run_id)'); // what the turns step created before v7 replaced it
  if (version < 3) for (const column of SNAPSHOT_COLUMNS) db.exec(`ALTER TABLE gates DROP COLUMN ${column}`);
  if (version < 2) {
    db.exec('DROP INDEX IF EXISTS messages_delivery');
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
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT v FROM kv WHERE k='shape'").get()).toEqual({ v: String(version) });
    expect(pendingMigrations(db)).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('turns_run', 'messages_inbox')").all()).toEqual([]);
    db.close();
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(1);
    const after = schemaSql(file);
    new Store(file).close();
    expect(schemaSql(file)).toEqual(after);
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(1);
  });

  it('backs up only when the ledger version changes, not for same-version drift repair', () => {
    const { dir, file } = tempFile();
    new Store(file).close();
    const db = new DatabaseSync(file);
    db.exec('DROP INDEX messages_run_id');
    db.close();
    new Store(file).close();
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    const extended = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, description: 'test step', up: (d: DatabaseSync) => d.exec('CREATE TABLE extra (x)') }];
    new Store(file, undefined, { migrations: extended }).close();
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(1);
  });

  it('rolls a throwing step back completely: user_version and schema stay at the last good step', () => {
    const { file } = tempFile();
    new Store(file).close();
    const v = SCHEMA_VERSION;
    const good: VersionedMigration = { version: v + 1, description: 'adds a table', up: (db) => db.exec('CREATE TABLE good (x)') };
    const bad: VersionedMigration = { version: v + 2, description: 'fails halfway', up: (db) => {
      db.exec('ALTER TABLE runs ADD COLUMN half TEXT');
      db.exec('CREATE INDEX half_idx ON runs(half)');
      throw new Error('step failed');
    } };
    expect(() => new Store(file, undefined, { migrations: [...MIGRATIONS, good, bad] })).toThrow(/step failed/);
    const db = new DatabaseSync(file, { readOnly: true });
    expect(userVersion(db)).toBe(v + 1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('good', 'half_idx')").all()).toEqual([{ name: 'good' }]);
    expect((db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name)).not.toContain('half');
    db.close();

    // Nothing at all changes when the very first pending step fails.
    const before = schemaSql(file);
    expect(() => new Store(file, undefined, { migrations: [...MIGRATIONS, good, bad] })).toThrow(/step failed/);
    expect(schemaSql(file)).toEqual(before);
  });

  it('refuses a database from a newer coagent without touching it', () => {
    const { dir, file } = tempFile();
    new Store(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 2}`);
    raw.exec('DROP INDEX messages_run_id'); // repair must not run either
    raw.close();
    const before = schemaSql(file);
    const message = `database is from a newer coagent (v${SCHEMA_VERSION + 2}, this plugin supports v${SCHEMA_VERSION}); upgrade the plugin`;
    expect(() => new Store(file)).toThrow(message);
    expect(schemaSql(file)).toEqual(before);
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    const db = new DatabaseSync(file, { readOnly: true });
    expect(() => pendingMigrations(db)).toThrow(message);
    db.close();
  });

  it('uses the intended index for the real hot-path statements in store.ts', () => {
    const { file } = tempFile();
    const store = new Store(file);
    const seen: string[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      seen.push(sql);
      return prepare.call(this, sql);
    });
    /** The statements one store call prepares. */
    const capture = (fn: () => unknown) => { seen.length = 0; fn(); return [...seen]; };
    const cases: [string, () => unknown, string][] = [
      ['agents(runId)', () => store.agents('r'), 'agents_run_created'],
      ['agents(runId) usage', () => store.agents('r'), 'turns_run_agent_id'],
      ['agentByAppSession', () => store.agentByAppSession('a'), 'agents_app_session'],
      ['messages(runId)', () => store.messages('r'), 'messages_run_id'],
      ['expiredDispatches', () => store.expiredDispatches(0), 'messages_delivery_id'],
      ['agentsWithUndelivered', () => store.agentsWithUndelivered(), 'messages_delivery_id'],
      ['lastGateMessage', () => store.lastGateMessage(1), 'messages_gate_id'],
      ['undeliveredGateMessage', () => store.undeliveredGateMessage(1), 'messages_gate_id'],
      ['gates(runId)', () => store.gates('r'), 'gates_run_id'],
      ['pendingGate', () => store.pendingGate('r', 'merge', 'w'), 'gates_pending_subject'],
      ['events(runId)', () => store.events('r'), 'events_run'],
    ];
    const db = new DatabaseSync(file, { readOnly: true });
    for (const [name, call, index] of cases) {
      const statements = capture(call).filter((sql) => /^\s*SELECT/i.test(sql));
      expect(statements.length, name).toBeGreaterThan(0);
      const plans = statements.map((sql) => (prepare.call(db, `EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail).join('\n'));
      expect(plans.join('\n---\n'), name).toContain(`INDEX ${index}`);
    }
    db.close();
    store.close();
  });
});
