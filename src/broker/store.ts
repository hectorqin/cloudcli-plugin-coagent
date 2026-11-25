import { DatabaseSync } from 'node:sqlite';
import type {
  AgentDTO, AgentStatus, DeliveryState, EventDTO, EventType, GateDTO, GateKind, GateStatus, MergeSnapshot,
  MergeSnapshotData, MessageDTO, PlanStatus, Provider, RunDTO,
} from '../shared/protocol.js';

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

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

  constructor(file: string, private now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Idempotent: safe on fresh and on any older database. */
  private migrate() {
    const cols = (this.db.prepare('PRAGMA table_info(messages)').all() as Row[]).map((r) => String(r.name));
    if (!cols.includes('gate_id')) this.db.exec('ALTER TABLE messages ADD COLUMN gate_id INTEGER');
    if (!cols.includes('delivery_state')) {
      this.transaction(() => {
        this.db.exec("ALTER TABLE messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'queued'");
        // Older databases only had delivered_at (set before dispatch, cleared on failure): it is the truth we have.
        this.db.exec("UPDATE messages SET delivery_state = 'delivered' WHERE delivered_at IS NOT NULL");
      });
    }
    if (!cols.includes('attempts')) this.db.exec('ALTER TABLE messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('lease_until')) this.db.exec('ALTER TABLE messages ADD COLUMN lease_until INTEGER');
    this.db.exec('DROP INDEX IF EXISTS messages_inbox');
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_delivery ON messages(to_agent, delivery_state)');
    const gateCols = new Set((this.db.prepare('PRAGMA table_info(gates)').all() as Row[]).map((r) => String(r.name)));
    const gateMigrations: Record<string, string> = {
      worker_head: 'TEXT', lead_head: 'TEXT', merge_base: 'TEXT', diff_stat: 'TEXT', name_status: 'TEXT',
      snapshot_files: 'TEXT', unified_diff: 'TEXT', diff_truncated: 'INTEGER',
    };
    for (const [name, type] of Object.entries(gateMigrations)) {
      if (!gateCols.has(name)) this.db.exec(`ALTER TABLE gates ADD COLUMN ${name} ${type}`);
    }
  }

  close() { this.db.close(); }

  diagnostics(now = Date.now()) {
    const expected: Record<string, string[]> = {
      runs: ['id', 'lead_agent_id', 'project_path', 'status', 'plan_status', 'created_at', 'ended_at'],
      agents: ['id', 'run_id', 'role', 'provider', 'status', 'created_at'],
      messages: ['id', 'run_id', 'to_agent', 'kind', 'body', 'created_at', 'delivered_at', 'gate_id',
        'delivery_state', 'attempts', 'lease_until'],
      gates: ['id', 'run_id', 'kind', 'status', 'created_at', 'worker_head', 'lead_head', 'merge_base',
        'diff_stat', 'name_status', 'snapshot_files', 'unified_diff', 'diff_truncated'],
      events: ['id', 'run_id', 'type', 'data', 'created_at'],
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
      schema: { ok: Object.keys(missingColumns).length === 0, columns: actualColumns, missingColumns },
      counts: { runs: countBy('runs'), agents: countBy('agents') },
      stuckBusy: [...this.busySince.entries()].filter(([, since]) => now - since > 30 * 60_000)
        .map(([agentId, since]) => ({ agentId, since: new Date(since).toISOString() })),
      undelivered: { total: Number(undelivered.count), byAgent: undeliveredByAgent },
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
    return r ? toRun(r) : null;
  }
  runs(): RunDTO[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as Row[]).map(toRun);
  }
  setPlanStatus(runId: string, st: PlanStatus) {
    this.db.prepare('UPDATE runs SET plan_status = ? WHERE id = ?').run(st, runId);
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
    return (this.db.prepare('SELECT * FROM agents WHERE run_id = ? ORDER BY created_at').all(runId) as Row[])
      .map((r) => this.toAgent(r));
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
      WHERE m.delivery_state = 'queued' AND r.status = 'active'`).all() as Row[]).map((r) => String(r.id));
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
    return (this.db.prepare(`SELECT a.* FROM agents a JOIN runs r ON r.id = a.run_id WHERE r.status = 'active' ORDER BY a.created_at`)
      .all() as Row[]).map((r) => this.toAgent(r));
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
  decideGate(id: number, status: GateStatus, comment: string | null) {
    this.db.prepare('UPDATE gates SET status = ?, comment = ?, decided_at = ? WHERE id = ?').run(status, comment, this.ts(), id);
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

  // ── kv (settings) ─────────────────────────────────────────────────
  getJson<T>(k: string, fallback: T): T {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as Row | undefined;
    return r ? (JSON.parse(String(r.v)) as T) : fallback;
  }
  setJson(k: string, v: unknown) {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
  }

  private toAgent(r: Row): AgentDTO {
    return {
      id: String(r.id), runId: String(r.run_id), role: String(r.role), provider: String(r.provider) as Provider,
      providerSessionId: s(r.provider_session_id), appSessionId: s(r.app_session_id), cwd: String(r.cwd),
      branch: s(r.branch), worktreePath: s(r.worktree_path), status: String(r.status) as AgentStatus,
      task: s(r.task), result: s(r.result), lastError: s(r.last_error), busy: this.busy.has(String(r.id)),
      activity: (this.activity.get(String(r.id)) ?? []).map(({ ts, text }) => ({ ts, text })),
    };
  }
}

function toRun(r: Row): RunDTO {
  return {
    id: String(r.id), leadAgentId: String(r.lead_agent_id), projectPath: String(r.project_path),
    status: String(r.status) as RunDTO['status'], planStatus: String(r.plan_status) as PlanStatus, createdAt: String(r.created_at),
  };
}
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
