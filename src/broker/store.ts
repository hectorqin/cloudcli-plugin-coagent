import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentDTO, AgentStatus, DeliveryState, EventDTO, EventType, GateDTO, GateKind, GateStatus, MergeSnapshot,
  AgentUsageDTO, MergeSnapshotData, MessageDTO, PlanStatus, Provider, RunDTO, RunUsageDTO, TurnOutcome,
} from '../shared/protocol.js';
import type { TurnUsage } from './usage.js';
import { writeLog } from './log.js';

type Row = Record<string, unknown>;
/** VACUUM INTO copies on the order of 100+ MiB/s, so this stays well inside CloudCLI's 10 s startup limit. */
const MAX_BACKUP_BYTES = 512 * 2 ** 20;
export const SKIP_BACKUP_MARKER = 'skip-next-backup';
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  lead_agent_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  plan_status TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT,
  app_session_id TEXT,
  cwd TEXT NOT NULL,
  branch TEXT,
  worktree_path TEXT,
  status TEXT NOT NULL,
  task TEXT,
  result TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_provider_session ON agents(provider, provider_session_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  from_agent TEXT,
  to_agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  subject_agent TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  comment TEXT,
  worker_head TEXT,
  lead_head TEXT,
  merge_base TEXT,
  diff_stat TEXT,
  name_status TEXT,
  snapshot_files TEXT,
  unified_diff TEXT,
  diff_truncated INTEGER,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/**
 * An idempotent description of the objects one version step creates. A step's `up` applies it; drift repair (see
 * VersionedMigration.repair) re-applies it to a current database whose schema was damaged by hand.
 */
export interface SchemaFragment {
  /** Table whose columns this fragment adds (and which `create` creates). */
  table?: string;
  /** CREATE TABLE/INDEX IF NOT EXISTS statement(s) run first. */
  create?: string;
  /** Columns added with ALTER TABLE ADD COLUMN when missing: name → type/constraints. */
  columns?: Record<string, string>;
  /** SQL run in the same transaction as adding that column (backfill for older rows). */
  backfill?: Record<string, string>;
  /** Indexes that must exist: name → CREATE INDEX IF NOT EXISTS statement. */
  indexes?: Record<string, string>;
  /** Indexes that must no longer exist. */
  dropIndexes?: string[];
}

/**
 * One row per turn CloudCLI accepted for an agent (see TurnOutcome). Usage columns hold the last usage event of the
 * turn; usage_kind says whether they are a context snapshot ('context') or the turn's bill ('turn').
 */
export const TURN_COLUMNS: Readonly<Record<string, string>> = {
  agent_id: 'TEXT', run_id: 'TEXT', started_at: 'TEXT', ended_at: 'TEXT', duration_ms: 'INTEGER', outcome: 'TEXT',
  usage_kind: 'TEXT', context_tokens: 'INTEGER', context_window: 'INTEGER', input_tokens: 'INTEGER',
  output_tokens: 'INTEGER', cache_read_tokens: 'INTEGER', cache_creation_tokens: 'INTEGER',
};

export const TURNS_MIGRATION: SchemaFragment = {
  table: 'turns',
  create: `CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    started_at TEXT NOT NULL
  )`,
  columns: TURN_COLUMNS,
  // turns_run(run_id) of older databases is dropped by v7: turns_run_agent_id(run_id, ...) covers it.
  indexes: { turns_agent: 'CREATE INDEX IF NOT EXISTS turns_agent ON turns(agent_id, id)' },
};

/** The base SCHEMA as one fragment per statement, so drift repair can name exactly what is missing. */
const BASE_FRAGMENTS: readonly SchemaFragment[] = SCHEMA.split(';').map((x) => x.trim()).filter(Boolean).map((stmt) => {
  const table = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(stmt);
  if (table) return { table: table[1], create: stmt };
  const index = /^CREATE INDEX IF NOT EXISTS (\w+)/.exec(stmt);
  if (!index) throw new Error(`unexpected base schema statement: ${stmt}`);
  return { indexes: { [index[1]]: stmt } };
});

const DELIVERY_FRAGMENT: SchemaFragment = {
  table: 'messages',
  columns: {
    gate_id: 'INTEGER',
    delivery_state: "TEXT NOT NULL DEFAULT 'queued'",
    attempts: 'INTEGER NOT NULL DEFAULT 0',
    lease_until: 'INTEGER',
  },
  backfill: {
    // Older databases only had delivered_at (set before dispatch, cleared on failure): it is the truth we have.
    delivery_state: "UPDATE messages SET delivery_state = 'delivered' WHERE delivered_at IS NOT NULL",
  },
  indexes: { messages_delivery: 'CREATE INDEX IF NOT EXISTS messages_delivery ON messages(to_agent, delivery_state)' },
  dropIndexes: ['messages_inbox'],
};

const SNAPSHOT_FRAGMENT: SchemaFragment = {
  table: 'gates',
  columns: {
    worker_head: 'TEXT', lead_head: 'TEXT', merge_base: 'TEXT', diff_stat: 'TEXT', name_status: 'TEXT',
    snapshot_files: 'TEXT', unified_diff: 'TEXT', diff_truncated: 'INTEGER',
  },
};

// Set by endRun before it waits for the repository lock: the persisted stop intent (see Broker.endRun/recover).
const ENDING_FRAGMENT: SchemaFragment = { table: 'runs', columns: { ending_at: 'TEXT' } };

// A worker paused by a provider usage/rate limit: when the broker resumes it, why, and whether the resume needs a
// "you were interrupted" message (its interrupted turn had been accepted). Persisted so a restart keeps the plan.
const PAUSE_FRAGMENT: SchemaFragment = { table: 'agents', columns: { resume_at: 'TEXT', pause_reason: 'TEXT', pause_nudge: 'INTEGER' } };

/** Indexes for the hot queries in this file; test/migrations.test.ts checks each one against the real statement. */
const HOT_INDEXES_FRAGMENT: SchemaFragment = {
  indexes: {
    agents_run_created: 'CREATE INDEX IF NOT EXISTS agents_run_created ON agents(run_id, created_at)',
    agents_app_session: 'CREATE INDEX IF NOT EXISTS agents_app_session ON agents(app_session_id)',
    messages_run_id: 'CREATE INDEX IF NOT EXISTS messages_run_id ON messages(run_id, id)',
    messages_delivery_id: 'CREATE INDEX IF NOT EXISTS messages_delivery_id ON messages(delivery_state, id)',
    messages_gate_id: 'CREATE INDEX IF NOT EXISTS messages_gate_id ON messages(gate_id, id)',
    gates_run_id: 'CREATE INDEX IF NOT EXISTS gates_run_id ON gates(run_id, id)',
    gates_pending_subject: 'CREATE INDEX IF NOT EXISTS gates_pending_subject ON gates(run_id, kind, status, subject_agent)',
    turns_run_agent_id: 'CREATE INDEX IF NOT EXISTS turns_run_agent_id ON turns(run_id, agent_id, id)',
  },
  // turns_run is redundant with turns_run_agent_id; messages_delivery_lease_id was this index set's pre-release shape.
  dropIndexes: ['turns_run', 'messages_delivery_lease_id'],
};

type Tx = (fn: () => void) => void;
const inline: Tx = (fn) => fn();

/** Applies a fragment idempotently. `tx` wraps each column's ALTER + backfill (a no-op inside a step's transaction). */
function applyFragment(db: DatabaseSync, f: SchemaFragment, tx: Tx = inline) {
  if (f.create) db.exec(f.create);
  if (f.table && f.columns) {
    const cols = new Set((db.prepare(`PRAGMA table_info(${f.table})`).all() as Row[]).map((r) => String(r.name)));
    for (const [name, type] of Object.entries(f.columns)) {
      if (cols.has(name)) continue;
      tx(() => {
        db.exec(`ALTER TABLE ${f.table} ADD COLUMN ${name} ${type}`);
        const backfill = f.backfill?.[name];
        if (backfill) db.exec(backfill);
      });
    }
  }
  for (const i of f.dropIndexes ?? []) db.exec(`DROP INDEX IF EXISTS ${i}`);
  for (const sql of Object.values(f.indexes ?? {})) db.exec(sql);
}

/** What applyFragment would change, in the same order (read-only). */
function fragmentPending(db: DatabaseSync, f: SchemaFragment, tables: Set<string>, indexes: Set<string>): string[] {
  const out: string[] = [];
  if (f.table && !tables.has(f.table)) {
    out.push(`table ${f.table}`);
    return out;
  }
  if (f.table && f.columns) {
    const cols = new Set((db.prepare(`PRAGMA table_info(${f.table})`).all() as Row[]).map((r) => String(r.name)));
    for (const c of Object.keys(f.columns)) if (!cols.has(c)) out.push(`column ${f.table}.${c}`);
  }
  for (const i of f.dropIndexes ?? []) if (indexes.has(i)) out.push(`drop index ${i}`);
  for (const i of Object.keys(f.indexes ?? {})) if (!indexes.has(i)) out.push(`index ${i}`);
  return out;
}

export interface VersionedMigration {
  /** Monotonically increasing, gap-free; append only. Never edit a released step's `up`. */
  version: number;
  description: string;
  /** Primary table, when the step has one (introspection only). */
  table?: string;
  /** Runs in one transaction with the PRAGMA user_version update: all of it commits, or none of it. */
  up(db: DatabaseSync): void;
  /**
   * Optional drift repair: idempotent fragments re-applied on every open to a database at or past this version (for
   * a hand-damaged schema; never backed up, never changes user_version). Unlike `up`, this may be edited later: when
   * a newer step drops or renames something, remove it here too, or repair would bring it back.
   */
  repair?: readonly SchemaFragment[];
}

const fragmentStep = (version: number, description: string, fragments: readonly SchemaFragment[], table?: string): VersionedMigration => ({
  version, description, table, repair: fragments,
  up: (db) => { for (const f of fragments) applyFragment(db, f); },
});

/**
 * The schema ledger. PRAGMA user_version records the last step applied; Store applies every newer step in order, each
 * in its own transaction together with the user_version bump, and backs the database up first whenever a step is
 * pending. A database whose user_version is newer than the last step here refuses to open (downgrade).
 *
 * Databases from before the ledger (user_version 0) are matched to v1–v6 by inferredLegacyVersion().
 *
 * To change the schema, APPEND a step; never reorder, renumber or edit a released `up`:
 *
 *   { version: N, description: 'short summary', up: (db) => { db.exec('ALTER TABLE ...'); } }
 *
 * - `up` may run any SQL: renames, table rebuilds, constraint changes, multi-statement backfills. It must not COMMIT.
 *   For a purely additive change, `fragmentStep(N, description, [fragment])` also gives it drift repair.
 * - Also update Store.diagnostics() (its `expected` column map) for new tables/columns; pendingMigrations() and the
 *   repair list follow from `repair` automatically.
 * - Add the shape to test/migrations.test.ts (upgrade from N-1, idempotent, backup only on the version change).
 * - Reserved for branches in flight: v8 = result details (A2), v9 = reviews (A3). Take the next free number when
 *   rebasing onto whichever lands first.
 */
export const MIGRATIONS: readonly VersionedMigration[] = [
  { version: 1, description: 'initial run, agent, message, gate and event schema', repair: BASE_FRAGMENTS,
    up: (db) => db.exec(SCHEMA) },
  fragmentStep(2, 'reliable message delivery leases', [DELIVERY_FRAGMENT], 'messages'),
  fragmentStep(3, 'merge gate snapshots', [SNAPSHOT_FRAGMENT], 'gates'),
  fragmentStep(4, 'turn accounting', [TURNS_MIGRATION], 'turns'),
  fragmentStep(5, 'persisted run ending intent', [ENDING_FRAGMENT], 'runs'),
  fragmentStep(6, 'paused worker resume state', [PAUSE_FRAGMENT], 'agents'),
  fragmentStep(7, 'hot-path query indexes', [HOT_INDEXES_FRAGMENT]),
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

const hasColumn = (db: DatabaseSync, table: string, column: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((r) => String(r.name) === column);
const hasTable = (db: DatabaseSync, table: string) => !!db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
).get(table);

/** Infer the newest contiguous historical shape for databases created before the ledger existed. Frozen at v6. */
function inferredLegacyVersion(db: DatabaseSync): number {
  if (!['runs', 'agents', 'messages', 'gates', 'events', 'kv'].every((table) => hasTable(db, table))) return 0;
  let version = 1;
  if (!hasColumn(db, 'messages', 'delivery_state')) return version;
  version = 2;
  if (!hasColumn(db, 'gates', 'worker_head')) return version;
  version = 3;
  if (!hasTable(db, 'turns')) return version;
  version = 4;
  if (!hasColumn(db, 'runs', 'ending_at')) return version;
  version = 5;
  if (!hasColumn(db, 'agents', 'resume_at')) return version;
  return 6;
}

const recordedVersion = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as Row).user_version ?? 0);

export function schemaVersion(db: DatabaseSync): number {
  return recordedVersion(db) || inferredLegacyVersion(db);
}

/** Refuses a database written by a newer coagent: its schema may not mean what this code expects. */
function assertSupported(db: DatabaseSync, latest: number) {
  const recorded = recordedVersion(db);
  if (recorded > latest) {
    throw new Error(`database is from a newer coagent (v${recorded}, this plugin supports v${latest}); upgrade the plugin`);
  }
}

/** Drift repair a database at `version` gets: the repair fragments of every step it already has, in order. */
function repairFragments(version: number, migrations: readonly VersionedMigration[]): SchemaFragment[] {
  return migrations.filter((m) => m.version <= version).flatMap((m) => m.repair ?? []);
}

function names(db: DatabaseSync, type: 'table' | 'index') {
  return new Set((db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as Row[]).map((r) => String(r.name)));
}

/** Read-only description of the version steps and the drift repair Store would apply. Throws for a newer database. */
export function pendingMigrations(db: DatabaseSync): string[] {
  assertSupported(db, SCHEMA_VERSION);
  const version = schemaVersion(db);
  const steps = MIGRATIONS.filter((m) => m.version > version);
  if (steps.length) return steps.map((m) => `v${m.version}: ${m.description}`);
  const tables = names(db, 'table');
  const indexes = names(db, 'index');
  return repairFragments(version, MIGRATIONS).flatMap((f) => fragmentPending(db, f, tables, indexes));
}

export interface NewAgent {
  id: string;
  runId: string;
  role: string;
  provider: Provider;
  providerSessionId?: string | null;
  appSessionId?: string | null;
  cwd: string;
  branch?: string | null;
  worktreePath?: string | null;
  status: AgentStatus;
  task?: string | null;
}

/** Single source of truth for coagent state. Synchronous (node:sqlite), safe because the broker is one process. */
export class Store {
  private db: DatabaseSync;
  /** In-flight dispatches are process-local and intentionally not persisted. */
  readonly busy = new Set<string>();
  readonly busySince = new Map<string, number>();
  /** Recent activity per agent, captured from the run streams (process-local, like `busy`). */
  readonly activity = new Map<string, { ts: string; text: string; key?: string }[]>();

  private readonly migrations: readonly VersionedMigration[];

  /** `opts.migrations` replaces the ledger (tests only). */
  constructor(file: string, private now: () => Date = () => new Date(),
    opts: { maxBackupBytes?: number; migrations?: readonly VersionedMigration[] } = {}) {
    this.migrations = opts.migrations ?? MIGRATIONS;
    this.db = new DatabaseSync(file);
    try {
      assertSupported(this.db, this.latestVersion);
      if (this.needsMigration()) this.backupOrSkip(file, opts.maxBackupBytes ?? MAX_BACKUP_BYTES);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Whether opening this existing coagent database will apply any schema change (same list migrate() applies). */
  private needsMigration() {
    const userTables = this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as Row;
    if (Number(userTables.n) === 0) return false; // A new/empty database has no user state to preserve.
    return schemaVersion(this.db) < this.latestVersion;
  }

  private get latestVersion() { return this.migrations.at(-1)?.version ?? 0; }

  /**
   * The backup runs before the broker prints its readiness line, and CloudCLI kills a plugin that is not ready within
   * 10 s, so a database too large to copy in time refuses to start with instructions instead of being killed mid-copy.
   * Escape hatch: a `skip-next-backup` file next to the database (consumed on use) or COAGENT_SKIP_BACKUP=1.
   */
  private backupOrSkip(file: string, maxBytes: number) {
    const marker = path.join(path.dirname(file), SKIP_BACKUP_MARKER);
    if (fs.existsSync(marker) || process.env.COAGENT_SKIP_BACKUP === '1') {
      writeLog('warn', 'skipping database migration backup by explicit override', { db: file });
      fs.rmSync(marker, { force: true });
      return;
    }
    const bytes = [file, `${file}-wal`].reduce((sum, f) => sum + (fs.statSync(f, { throwIfNoEntry: false })?.size ?? 0), 0);
    if (bytes > maxBytes) {
      throw new Error(`database ${file} is ${Math.round(bytes / 2 ** 20)} MiB, too large to back up within CloudCLI's `
        + `startup limit; copy it somewhere safe, then create ${marker} and restart to migrate without a backup`);
    }
    this.backupBeforeMigration(file);
  }

  /** VACUUM INTO includes committed WAL contents in one consistent, standalone SQLite file. */
  private backupBeforeMigration(file: string) {
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = this.now().toISOString().replace(/[-:.]/g, '');
    let backup = path.join(dir, `coagent-${stamp}.db`);
    for (let suffix = 1; fs.existsSync(backup); suffix++) backup = path.join(dir, `coagent-${stamp}-${suffix}.db`);
    const started = Date.now();
    try {
      this.db.prepare('VACUUM INTO ?').run(backup);
      fs.chmodSync(backup, 0o600);

      const backups = fs.readdirSync(dir).filter((name) => /^coagent-.*\.db$/.test(name)).map((name) => {
        const filename = path.join(dir, name);
        return { filename, name, mtime: fs.statSync(filename).mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
      for (const old of backups.slice(5)) fs.rmSync(old.filename);
      writeLog('info', 'database migration backup complete', {
        backup, durationMs: Date.now() - started, bytes: fs.statSync(backup).size,
      });
    } catch (error) {
      try { fs.rmSync(backup, { force: true }); } catch { /* preserve the original failure */ }
      throw new Error(`database migration backup failed before schema changes: ${(error as Error).message}`, { cause: error });
    }
  }

  /** Idempotent: each version step and its ledger update commit atomically; then drift repair for steps <= version. */
  private migrate() {
    let version = schemaVersion(this.db);
    for (const m of this.migrations) {
      if (m.version <= version) continue;
      this.transaction(() => {
        m.up(this.db);
        this.db.exec(`PRAGMA user_version = ${m.version}`);
      });
      version = m.version;
    }
    for (const f of repairFragments(version, this.migrations)) applyFragment(this.db, f, (fn) => this.transaction(fn));
  }

  close() { this.db.close(); }

  diagnostics(now = Date.now()) {
    const expected: Record<string, string[]> = {
      runs: ['id', 'lead_agent_id', 'project_path', 'status', 'plan_status', 'created_at', 'ended_at', 'ending_at'],
      agents: ['id', 'run_id', 'role', 'provider', 'status', 'created_at', 'resume_at', 'pause_reason', 'pause_nudge'],
      messages: ['id', 'run_id', 'to_agent', 'kind', 'body', 'created_at', 'delivered_at', 'gate_id',
        'delivery_state', 'attempts', 'lease_until'],
      gates: ['id', 'run_id', 'kind', 'status', 'created_at', 'worker_head', 'lead_head', 'merge_base',
        'diff_stat', 'name_status', 'snapshot_files', 'unified_diff', 'diff_truncated'],
      events: ['id', 'run_id', 'type', 'data', 'created_at'],
      turns: ['id', ...Object.keys(TURN_COLUMNS)],
      kv: ['k', 'v'],
    };
    const missingColumns: Record<string, string[]> = {};
    const actualColumns: Record<string, string[]> = {};
    for (const [table, columns] of Object.entries(expected)) {
      const names = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name));
      actualColumns[table] = names;
      const actual = new Set(names);
      const missing = columns.filter((c) => !actual.has(c));
      if (missing.length) missingColumns[table] = missing;
    }
    const countBy = (table: 'runs' | 'agents') => Object.fromEntries(
      (this.db.prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`).all() as Row[])
        .map((r) => [String(r.status), Number(r.count)]),
    );
    const undelivered = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE delivered_at IS NULL').get() as Row;
    const undeliveredByAgent = Object.fromEntries((this.db.prepare(
      'SELECT to_agent, COUNT(*) AS count FROM messages WHERE delivered_at IS NULL GROUP BY to_agent',
    ).all() as Row[]).map((r) => [String(r.to_agent), Number(r.count)]));
    return {
      schema: { version: schemaVersion(this.db), latestVersion: this.latestVersion,
        ok: Object.keys(missingColumns).length === 0, columns: actualColumns, missingColumns },
      counts: { runs: countBy('runs'), agents: countBy('agents') },
      stuckBusy: [...this.busySince.entries()].filter(([, since]) => now - since > 30 * 60_000)
        .map(([agentId, since]) => ({ agentId, since: new Date(since).toISOString() })),
      undelivered: { total: Number(undelivered.count), byAgent: undeliveredByAgent },
      endingRuns: this.endingRuns(),
    };
  }
  private ts() { return this.now().toISOString(); }

  private txDepth = 0;
  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth) { this.txDepth++; try { return fn(); } finally { this.txDepth--; } }
    this.db.exec('BEGIN');
    this.txDepth = 1;
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } finally { this.txDepth = 0; }
  }

  // ── runs ──────────────────────────────────────────────────────────
  createRun(id: string, leadAgentId: string, projectPath: string) {
    this.db.prepare('INSERT INTO runs (id, lead_agent_id, project_path, created_at) VALUES (?,?,?,?)')
      .run(id, leadAgentId, projectPath, this.ts());
  }
  run(id: string): RunDTO | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toRun(r) : null;
  }
  runs(): RunDTO[] {
    const usage = this.runUsages();
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as Row[]).map((r) => this.toRun(r, usage));
  }
  /** The run list for the tab: counts come from grouped queries, so the cost does not grow per run. */
  runSummaries(): (RunDTO & { agentCount: number; pendingGates: number })[] {
    const count = (sql: string) => new Map((this.db.prepare(sql).all() as Row[]).map((r) => [String(r.k), Number(r.n)]));
    const agents = count('SELECT run_id AS k, COUNT(*) AS n FROM agents GROUP BY run_id');
    const gates = count("SELECT run_id AS k, COUNT(*) AS n FROM gates WHERE status = 'pending' GROUP BY run_id");
    return this.runs().map((r) => ({ ...r, agentCount: agents.get(r.id) ?? 0, pendingGates: gates.get(r.id) ?? 0 }));
  }
  /** Lead agent ids of every run (cheap: no usage). */
  leadIds(): Set<string> {
    return new Set((this.db.prepare('SELECT lead_agent_id AS id FROM runs').all() as Row[]).map((r) => String(r.id)));
  }
  setPlanStatus(runId: string, st: PlanStatus) {
    this.db.prepare('UPDATE runs SET plan_status = ? WHERE id = ?').run(st, runId);
  }
  /** Persists the intent to end an active run (no-op otherwise). From now on nothing may start a turn in it. */
  markEnding(runId: string) {
    this.db.prepare("UPDATE runs SET ending_at = COALESCE(ending_at, ?) WHERE id = ? AND status = 'active'").run(this.ts(), runId);
  }
  /** Runs that endRun has marked, active (stop not finished) or ended: what recovery must complete. */
  markedRuns(): RunDTO[] {
    return (this.db.prepare('SELECT * FROM runs WHERE ending_at IS NOT NULL').all() as Row[]).map((r) => this.toRun(r));
  }
  /** Active runs whose stop has not finished yet, oldest first, with their age on this store's clock. */
  endingRuns(): { runId: string; endingAt: string; ageMs: number }[] {
    const now = this.now().getTime();
    return (this.db.prepare("SELECT id, ending_at FROM runs WHERE status = 'active' AND ending_at IS NOT NULL ORDER BY ending_at")
      .all() as Row[]).map((r) => ({ runId: String(r.id), endingAt: String(r.ending_at), ageMs: Math.max(0, now - Date.parse(String(r.ending_at))) }));
  }
  hasEvent(runId: string, type: EventType): boolean {
    return !!this.db.prepare('SELECT 1 FROM events WHERE run_id = ? AND type = ? LIMIT 1').get(runId, type);
  }
  endRun(runId: string) {
    this.db.prepare("UPDATE runs SET status = 'ended', ended_at = ? WHERE id = ?").run(this.ts(), runId);
    this.db.prepare("UPDATE agents SET status = 'ended' WHERE run_id = ? AND status NOT IN ('merged')").run(runId);
  }

  // ── agents ────────────────────────────────────────────────────────
  createAgent(a: NewAgent) {
    this.db.prepare(`INSERT INTO agents (id, run_id, role, provider, provider_session_id, app_session_id, cwd, branch,
      worktree_path, status, task, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      a.id, a.runId, a.role, a.provider, a.providerSessionId ?? null, a.appSessionId ?? null, a.cwd,
      a.branch ?? null, a.worktreePath ?? null, a.status, a.task ?? null, this.ts());
  }
  agent(id: string): AgentDTO | null {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toAgent(r) : null;
  }
  /** The session's agent in its most recent run, active or ended. */
  latestAgentByProviderSession(provider: Provider, providerSessionId: string): AgentDTO | null {
    const r = this.db.prepare(`SELECT a.* FROM agents a JOIN runs r ON r.id = a.run_id
      WHERE a.provider = ? AND a.provider_session_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`)
      .get(provider, providerSessionId) as Row | undefined;
    return r ? this.toAgent(r) : null;
  }
  agentByProviderSession(provider: Provider, providerSessionId: string): AgentDTO | null {
    const r = this.db.prepare(`SELECT a.* FROM agents a JOIN runs r ON r.id = a.run_id
      WHERE a.provider = ? AND a.provider_session_id = ? AND r.status = 'active'`).get(provider, providerSessionId) as Row | undefined;
    return r ? this.toAgent(r) : null;
  }
  agentByAppSession(appSessionId: string): AgentDTO | null {
    const r = this.db.prepare(`SELECT a.* FROM agents a JOIN runs r ON r.id = a.run_id
      WHERE a.app_session_id = ? ORDER BY r.status = 'active' DESC, r.created_at DESC LIMIT 1`).get(appSessionId) as Row | undefined;
    return r ? this.toAgent(r) : null;
  }
  agents(runId: string): AgentDTO[] {
    const usage = this.agentUsages({ col: 'run_id', value: runId });
    return (this.db.prepare('SELECT * FROM agents WHERE run_id = ? ORDER BY created_at').all(runId) as Row[])
      .map((r) => this.toAgent(r, usage));
  }
  updateAgent(id: string, patch: Partial<Pick<AgentDTO,
    'providerSessionId' | 'appSessionId' | 'status' | 'result' | 'lastError' | 'worktreePath'>>) {
    const cols: Record<string, string> = {
      providerSessionId: 'provider_session_id', appSessionId: 'app_session_id', status: 'status',
      result: 'result', lastError: 'last_error', worktreePath: 'worktree_path',
    };
    const entries = Object.entries(patch).filter(([k]) => k in cols);
    if (!entries.length) return;
    this.db.prepare(`UPDATE agents SET ${entries.map(([k]) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => (v ?? null) as string | null), id);
  }
  /** Marks a worker paused until `resumeAt` (ISO). `nudge`: its resume must tell it that a turn was cut off. */
  pauseAgent(id: string, resumeAt: string, reason: string, nudge: boolean, lastError: string | null) {
    this.db.prepare(`UPDATE agents SET status = 'paused', resume_at = ?, pause_reason = ?, pause_nudge = ?, last_error = ?
      WHERE id = ?`).run(resumeAt, reason, nudge ? 1 : 0, lastError, id);
  }
  /** Leaves the paused state (or clears stale pause data): sets `status` and forgets the resume plan. */
  clearPause(id: string, status: AgentStatus) {
    this.db.prepare('UPDATE agents SET status = ?, resume_at = NULL, pause_reason = NULL, pause_nudge = NULL WHERE id = ?')
      .run(status, id);
  }
  pauseNudge(id: string): boolean {
    const r = this.db.prepare('SELECT pause_nudge FROM agents WHERE id = ?').get(id) as Row | undefined;
    return Number(r?.pause_nudge ?? 0) === 1;
  }
  /** Paused workers of active runs whose resume time has come (no usage queries: called on every tick). */
  pausedDue(now: Date): { id: string; runId: string }[] {
    return (this.db.prepare(`SELECT a.id, a.run_id, a.resume_at FROM agents a JOIN runs r ON r.id = a.run_id
      WHERE a.status = 'paused' AND r.status = 'active'`).all() as Row[])
      .filter((r) => !(Date.parse(String(r.resume_at)) > now.getTime())) // a missing/unreadable time is due now
      .map((r) => ({ id: String(r.id), runId: String(r.run_id) }));
  }

  // ── messages ──────────────────────────────────────────────────────
  addMessage(runId: string, from: string | null, to: string, kind: MessageDTO['kind'], body: string, gateId: number | null = null): number {
    const r = this.db.prepare('INSERT INTO messages (run_id, from_agent, to_agent, kind, body, created_at, gate_id) VALUES (?,?,?,?,?,?,?)')
      .run(runId, from, to, kind, body, this.ts(), gateId);
    return Number(r.lastInsertRowid);
  }
  lastGateMessage(gateId: number): MessageDTO | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE gate_id = ? ORDER BY id DESC LIMIT 1').get(gateId) as Row | undefined;
    return r ? toMessage(r) : null;
  }
  /** The queued decision message of a gate, if the gate has been decided. */
  undeliveredGateMessage(gateId: number): MessageDTO | null {
    const r = this.db.prepare("SELECT * FROM messages WHERE gate_id = ? AND delivery_state = 'queued' ORDER BY id LIMIT 1")
      .get(gateId) as Row | undefined;
    return r ? toMessage(r) : null;
  }
  /** Messages waiting for delivery (not those a turn is currently carrying). */
  undelivered(agentId: string): MessageDTO[] {
    return (this.db.prepare("SELECT * FROM messages WHERE to_agent = ? AND delivery_state = 'queued' ORDER BY id").all(agentId) as Row[])
      .map(toMessage);
  }
  agentsWithUndelivered(): string[] {
    return (this.db.prepare(`SELECT DISTINCT m.to_agent AS id FROM messages m JOIN runs r ON r.id = m.run_id
      WHERE m.delivery_state = 'queued' AND r.status = 'active' AND r.ending_at IS NULL`).all() as Row[]).map((r) => String(r.id));
  }
  /** The first message ever addressed to an agent (a worker's task). */
  firstMessageId(agentId: string): number | null {
    const r = this.db.prepare('SELECT MIN(id) AS id FROM messages WHERE to_agent = ?').get(agentId) as Row | undefined;
    return r && r.id !== null && r.id !== undefined ? Number(r.id) : null;
  }
  /** Handed over directly (tool result): queued → delivered. */
  markDelivered(ids: number[]) {
    const st = this.db.prepare(`UPDATE messages SET delivery_state = 'delivered', delivered_at = ?, lease_until = NULL
      WHERE id = ? AND delivery_state != 'delivered'`);
    const ts = this.ts();
    this.transaction(() => { for (const id of ids) st.run(ts, id); });
  }
  /** queued → dispatching under a lease. Returns the ids actually claimed. */
  claimForDispatch(ids: number[], leaseUntil: number): number[] {
    const st = this.db.prepare(`UPDATE messages SET delivery_state = 'dispatching', attempts = attempts + 1, lease_until = ?
      WHERE id = ? AND delivery_state = 'queued'`);
    return this.transaction(() => ids.filter((id) => Number(st.run(leaseUntil, id).changes) > 0));
  }
  renewDispatch(ids: number[], leaseUntil: number) {
    const st = this.db.prepare("UPDATE messages SET lease_until = ? WHERE id = ? AND delivery_state = 'dispatching'");
    this.transaction(() => { for (const id of ids) st.run(leaseUntil, id); });
  }
  /** dispatching → delivered (the turn was accepted and finished). */
  completeDispatch(ids: number[]) {
    const st = this.db.prepare(`UPDATE messages SET delivery_state = 'delivered', delivered_at = ?, lease_until = NULL
      WHERE id = ? AND delivery_state = 'dispatching'`);
    const ts = this.ts();
    this.transaction(() => { for (const id of ids) st.run(ts, id); });
  }
  /** dispatching → queued (409, error, or an orphaned dispatch after a crash). */
  requeue(ids: number[]) {
    const st = this.db.prepare("UPDATE messages SET delivery_state = 'queued', lease_until = NULL WHERE id = ? AND delivery_state = 'dispatching'");
    this.transaction(() => { for (const id of ids) st.run(id); });
  }
  /** Dispatches whose lease ran out (the broker process that sent them is gone). */
  expiredDispatches(now: number): MessageDTO[] {
    return (this.db.prepare(`SELECT * FROM messages WHERE delivery_state = 'dispatching' AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY id`).all(now) as Row[]).map(toMessage);
  }
  /** queued → cancelled for every message still waiting for an agent that will never take a turn again. */
  cancelQueued(agentId: string): number {
    return Number(this.db.prepare("UPDATE messages SET delivery_state = 'cancelled' WHERE to_agent = ? AND delivery_state = 'queued'")
      .run(agentId).changes);
  }
  /** Messages waiting for or carried by a turn (they need a worker slot). */
  pendingCount(agentId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_agent = ? AND delivery_state IN ('queued', 'dispatching')")
      .get(agentId) as Row;
    return Number(r.n);
  }
  /** Whether a turn was ever started to deliver something to this agent. */
  everDispatched(agentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM messages WHERE to_agent = ? AND attempts > 0 LIMIT 1').get(agentId);
  }
  /** Messages currently carried by a turn, for one agent. */
  dispatching(agentId: string): MessageDTO[] {
    return (this.db.prepare("SELECT * FROM messages WHERE to_agent = ? AND delivery_state = 'dispatching' ORDER BY id").all(agentId) as Row[])
      .map(toMessage);
  }
  /** Agents of active runs, any status (for startup recovery). */
  activeRunAgents(): AgentDTO[] {
    const usage = this.agentUsages();
    return (this.db.prepare(`SELECT a.* FROM agents a JOIN runs r ON r.id = a.run_id WHERE r.status = 'active' ORDER BY a.created_at`)
      .all() as Row[]).map((r) => this.toAgent(r, usage));
  }
  messages(runId: string, limit = 500): MessageDTO[] {
    return (this.db.prepare('SELECT * FROM (SELECT * FROM messages WHERE run_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(runId, limit) as Row[]).map(toMessage);
  }

  // ── gates ─────────────────────────────────────────────────────────
  addGate(runId: string, kind: GateKind, requestedBy: string, subjectAgent: string | null, payload: string,
    snapshot: MergeSnapshotData | null = null): number {
    const r = this.db.prepare(`INSERT INTO gates (run_id, kind, requested_by, subject_agent, payload, created_at,
      worker_head, lead_head, merge_base, diff_stat, name_status, snapshot_files, unified_diff, diff_truncated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      runId, kind, requestedBy, subjectAgent, payload, this.ts(), snapshot?.workerHead ?? null, snapshot?.leadHead ?? null,
      snapshot?.mergeBase ?? null, snapshot?.stat ?? null, snapshot?.nameStatus ?? null,
      snapshot ? JSON.stringify(snapshot.files) : null, snapshot?.diff ?? null, snapshot ? Number(snapshot.diffTruncated) : null);
    return Number(r.lastInsertRowid);
  }
  gate(id: number): GateDTO | null {
    const r = this.db.prepare('SELECT * FROM gates WHERE id = ?').get(id) as Row | undefined;
    return r ? toGate(r) : null;
  }
  gatePatch(id: number): Pick<MergeSnapshotData, 'stat' | 'nameStatus' | 'diff' | 'diffTruncated'> | null {
    const r = this.db.prepare('SELECT diff_stat, name_status, unified_diff, diff_truncated FROM gates WHERE id = ? AND worker_head IS NOT NULL')
      .get(id) as Row | undefined;
    return r ? { stat: String(r.diff_stat ?? ''), nameStatus: String(r.name_status ?? ''), diff: String(r.unified_diff ?? ''), diffTruncated: Boolean(r.diff_truncated) } : null;
  }
  gates(runId: string): GateDTO[] {
    return (this.db.prepare('SELECT * FROM gates WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map(toGate);
  }
  pendingGate(runId: string, kind: GateKind, subjectAgent: string | null): GateDTO | null {
    const r = this.db.prepare(`SELECT * FROM gates WHERE run_id = ? AND kind = ? AND status = 'pending'
      AND subject_agent IS ?`).get(runId, kind, subjectAgent) as Row | undefined;
    return r ? toGate(r) : null;
  }
  /** pending → a terminal status. False when the gate was already decided (a decision is never overwritten). */
  decideGate(id: number, status: GateStatus, comment: string | null): boolean {
    return Number(this.db.prepare("UPDATE gates SET status = ?, comment = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, comment, this.ts(), id).changes) > 0;
  }

  // ── events ────────────────────────────────────────────────────────
  addEvent(runId: string, agentId: string | null, type: EventType, data: Record<string, unknown> = {}) {
    this.db.prepare('INSERT INTO events (run_id, agent_id, type, data, created_at) VALUES (?,?,?,?,?)')
      .run(runId, agentId, type, JSON.stringify(data), this.ts());
  }
  events(runId: string): EventDTO[] {
    return (this.db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id').all(runId) as Row[]).map((r) => ({
      id: Number(r.id), runId: String(r.run_id), agentId: s(r.agent_id), type: String(r.type) as EventType,
      data: JSON.parse(String(r.data)) as Record<string, unknown>, createdAt: String(r.created_at),
    }));
  }

  // ── turns ─────────────────────────────────────────────────────────
  /** Opens a turn row (CloudCLI accepted the turn). */
  startTurn(agentId: string, runId: string): number {
    const r = this.db.prepare('INSERT INTO turns (agent_id, run_id, started_at) VALUES (?,?,?)').run(agentId, runId, this.ts());
    return Number(r.lastInsertRowid);
  }
  /** Replaces the turn's usage with the latest usage event seen (only while the turn is open). */
  setTurnUsage(id: number, u: TurnUsage) {
    this.db.prepare(`UPDATE turns SET usage_kind = ?, context_tokens = ?, context_window = ?, input_tokens = ?, output_tokens = ?,
      cache_read_tokens = ?, cache_creation_tokens = ? WHERE id = ? AND ended_at IS NULL`).run(
      u.kind, u.contextTokens, u.contextWindow, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheCreationTokens, id);
  }
  /** Closes an open turn; its duration is measured from started_at. */
  finishTurn(id: number, outcome: TurnOutcome) {
    const r = this.db.prepare('SELECT started_at FROM turns WHERE id = ? AND ended_at IS NULL').get(id) as Row | undefined;
    if (!r) return;
    const now = this.now();
    const ms = Math.max(0, now.getTime() - Date.parse(String(r.started_at)));
    this.db.prepare('UPDATE turns SET ended_at = ?, duration_ms = ?, outcome = ? WHERE id = ?').run(now.toISOString(), ms, outcome, id);
  }
  /**
   * Closes every open turn not in `keep` as interrupted (the process that ran it is gone). Its duration is unknown:
   * the turn may have ended at any time before the restart. Returns the ids closed.
   */
  interruptOpenTurns(keep: Set<number> = new Set()): number[] {
    const open = (this.db.prepare('SELECT id FROM turns WHERE ended_at IS NULL').all() as Row[]).map((r) => Number(r.id))
      .filter((id) => !keep.has(id));
    const st = this.db.prepare("UPDATE turns SET ended_at = ?, outcome = 'interrupted' WHERE id = ? AND ended_at IS NULL");
    const ts = this.ts();
    this.transaction(() => { for (const id of open) st.run(ts, id); });
    return open;
  }
  turns(agentId: string) {
    return (this.db.prepare('SELECT * FROM turns WHERE agent_id = ? ORDER BY id').all(agentId) as Row[]).map((r) => ({
      id: Number(r.id), agentId: String(r.agent_id), runId: String(r.run_id), startedAt: String(r.started_at),
      endedAt: s(r.ended_at), durationMs: n(r.duration_ms), outcome: s(r.outcome) as TurnOutcome | null,
      usageKind: s(r.usage_kind) as TurnUsage['kind'] | null, contextTokens: n(r.context_tokens),
      contextWindow: n(r.context_window), inputTokens: n(r.input_tokens), outputTokens: n(r.output_tokens),
      cacheReadTokens: n(r.cache_read_tokens), cacheCreationTokens: n(r.cache_creation_tokens),
    }));
  }

  /**
   * Turn usage grouped by agent or by run, in a constant number of queries whatever the history size.
   * Sums: count, time, and the token bills of 'turn'-kind rows only. Context snapshots are never summed (they would
   * count the same conversation once per turn).
   * `filter` restricts the rows (one agent or one run); undefined = all turns.
   */
  private usageBy(by: 'agent_id' | 'run_id', filter?: { col: 'agent_id' | 'run_id'; value: string }) {
    const where = filter ? `WHERE ${filter.col} = ?` : '';
    const args = filter ? [filter.value] : [];
    const totals = this.db.prepare(`SELECT ${by} AS k, COUNT(*) AS turns, SUM(duration_ms) AS done_ms,
        SUM(CASE WHEN usage_kind = 'turn' THEN input_tokens END) AS input,
        SUM(CASE WHEN usage_kind = 'turn' THEN output_tokens END) AS output
      FROM turns ${where} GROUP BY ${by}`).all(...args) as Row[];
    const open = this.db.prepare(`SELECT ${by} AS k, started_at FROM turns
      ${where ? `${where} AND` : 'WHERE'} ended_at IS NULL`).all(...args) as Row[];
    const nowMs = this.now().getTime();
    const elapsed = (iso: unknown) => Math.max(0, nowMs - Date.parse(String(iso)));
    const out = new Map<string, RunUsageDTO & { currentTurnMs: number | null }>();
    for (const r of totals) {
      out.set(String(r.k), { turns: Number(r.turns), totalMs: n(r.done_ms), currentTurnMs: null, inputTokens: n(r.input), outputTokens: n(r.output) });
    }
    for (const r of open) {
      const u = out.get(String(r.k));
      if (!u) continue;
      const ms = elapsed(r.started_at);
      // currentTurnMs: the most recent open turn (an agent has at most one in this process).
      u.currentTurnMs = u.currentTurnMs === null ? ms : Math.min(u.currentTurnMs, ms);
      // totalMs: every open turn counts, so concurrent turns (lead + workers) all add up in a run total.
      u.totalMs = (u.totalMs ?? 0) + ms;
    }
    return out;
  }

  /** Usage of agents (all, or one run's, or one agent) in four queries. */
  agentUsages(filter?: { col: 'agent_id' | 'run_id'; value: string }): Map<string, AgentUsageDTO> {
    const totals = this.usageBy('agent_id', filter);
    const where = filter ? `AND ${filter.col} = ?` : '';
    const ctx = this.db.prepare(`SELECT agent_id, context_tokens, context_window FROM (
        SELECT agent_id, context_tokens, context_window, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY id DESC) AS rn
        FROM turns WHERE context_tokens IS NOT NULL ${where}) WHERE rn = 1`).all(...(filter ? [filter.value] : [])) as Row[];
    const ctxBy = new Map(ctx.map((r) => [String(r.agent_id), r]));
    const out = new Map<string, AgentUsageDTO>();
    for (const [id, t] of totals) {
      const c = ctxBy.get(id);
      out.set(id, {
        turns: t.turns, totalMs: t.totalMs, currentTurnMs: t.currentTurnMs,
        lastContextTokens: n(c?.context_tokens), contextWindow: n(c?.context_window),
        inputTokens: t.inputTokens, outputTokens: t.outputTokens,
      });
    }
    return out;
  }
  agentUsage(agentId: string): AgentUsageDTO {
    return this.agentUsages({ col: 'agent_id', value: agentId }).get(agentId) ?? emptyAgentUsage();
  }
  /** Run totals (all runs, or one). */
  runUsages(runId?: string): Map<string, RunUsageDTO> {
    const out = new Map<string, RunUsageDTO>();
    for (const [k, { currentTurnMs: _, ...t }] of this.usageBy('run_id', runId ? { col: 'run_id', value: runId } : undefined)) out.set(k, t);
    return out;
  }
  runUsage(runId: string): RunUsageDTO {
    return this.runUsages(runId).get(runId) ?? emptyRunUsage();
  }

  // ── kv (settings) ─────────────────────────────────────────────────
  getJson<T>(k: string, fallback: T): T {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as Row | undefined;
    return r ? (JSON.parse(String(r.v)) as T) : fallback;
  }
  setJson(k: string, v: unknown) {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
  }

  private toAgent(r: Row, usage?: Map<string, AgentUsageDTO>): AgentDTO {
    return {
      id: String(r.id), runId: String(r.run_id), role: String(r.role), provider: String(r.provider) as Provider,
      providerSessionId: s(r.provider_session_id), appSessionId: s(r.app_session_id), cwd: String(r.cwd),
      branch: s(r.branch), worktreePath: s(r.worktree_path), status: String(r.status) as AgentStatus,
      task: s(r.task), result: s(r.result), lastError: s(r.last_error),
      resumeAt: s(r.resume_at), pauseReason: s(r.pause_reason), busy: this.busy.has(String(r.id)),
      activity: (this.activity.get(String(r.id)) ?? []).map(({ ts, text }) => ({ ts, text })),
      usage: usage ? usage.get(String(r.id)) ?? emptyAgentUsage() : this.agentUsage(String(r.id)),
    };
  }

  private toRun(r: Row, usage?: Map<string, RunUsageDTO>): RunDTO {
    return {
      id: String(r.id), leadAgentId: String(r.lead_agent_id), projectPath: String(r.project_path),
      status: String(r.status) as RunDTO['status'], planStatus: String(r.plan_status) as PlanStatus, createdAt: String(r.created_at),
      ...(r.ending_at != null && String(r.status) === 'active' ? { ending: true } : {}),
      usage: usage ? usage.get(String(r.id)) ?? emptyRunUsage() : this.runUsage(String(r.id)),
    };
  }
}

const emptyAgentUsage = (): AgentUsageDTO => ({
  turns: 0, totalMs: null, currentTurnMs: null, lastContextTokens: null, contextWindow: null, inputTokens: null, outputTokens: null,
});
const emptyRunUsage = (): RunUsageDTO => ({ turns: 0, totalMs: null, inputTokens: null, outputTokens: null });

function toMessage(r: Row): MessageDTO {
  return {
    id: Number(r.id), runId: String(r.run_id), from: s(r.from_agent), to: String(r.to_agent),
    kind: String(r.kind) as MessageDTO['kind'], body: String(r.body), createdAt: String(r.created_at), deliveredAt: s(r.delivered_at),
    state: (r.delivery_state === undefined ? (r.delivered_at ? 'delivered' : 'queued') : String(r.delivery_state)) as DeliveryState,
    attempts: Number(r.attempts ?? 0),
  };
}
function toGate(r: Row): GateDTO {
  const snapshot = r.worker_head == null ? null : {
    workerHead: String(r.worker_head), leadHead: String(r.lead_head), mergeBase: String(r.merge_base),
    files: JSON.parse(String(r.snapshot_files ?? '[]')) as MergeSnapshot['files'],
    diffTruncated: Boolean(r.diff_truncated),
  };
  return {
    id: Number(r.id), runId: String(r.run_id), kind: String(r.kind) as GateKind, requestedBy: String(r.requested_by),
    subjectAgent: s(r.subject_agent), payload: String(r.payload), status: String(r.status) as GateStatus,
    comment: s(r.comment), createdAt: String(r.created_at), snapshot,
  };
}
