import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { codexBlock, removeCodexSection, upsertCodexToml } from '../src/broker/registration.js';
import { Store } from '../src/broker/store.js';
import { sseEvents } from '../src/broker/cloudcli.js';
import { callerFrom, protocolMismatch } from '../src/shim/mcp-shim.js';
import { pushActivity } from '../src/broker/broker.js';
import { VERSION } from '../src/shared/version.js';
import fs from 'node:fs';

describe('codex config.toml registration', () => {
  const block = codexBlock('/usr/bin/node', '/p/dist/mcp-shim.js');
  const existing = 'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n';

  it('appends, then is idempotent', () => {
    const once = upsertCodexToml(existing, block)!;
    expect(once).toContain('[mcp_servers.other]');
    expect(once).toContain('default_tools_approval_mode = "approve"');
    expect(upsertCodexToml(once, block)).toBeNull();
  });

  it('replaces a stale block without touching neighbours', () => {
    const stale = `${existing}\n[mcp_servers.coagent]\ncommand = "old"\nargs = ["old.js"]\n\n[profiles.x]\nmodel = "y"\n`;
    const next = upsertCodexToml(stale, block)!;
    expect(next).not.toContain('old.js');
    expect(next).toContain('[profiles.x]\nmodel = "y"');
    expect(next.match(/\[mcp_servers\.coagent\]/g)).toHaveLength(1);
  });

  it('removes only our section', () => {
    const next = removeCodexSection(upsertCodexToml(existing, block)!)!;
    expect(next).not.toContain('coagent');
    expect(next).toContain('[mcp_servers.other]');
    expect(removeCodexSection(existing)).toBeNull();
  });
});

describe('shim caller identity', () => {
  it('treats a legacy runtime without a protocol as v1', () => {
    expect(protocolMismatch(undefined)).toBeNull();
    expect(protocolMismatch(1)).toBeNull();
    expect(protocolMismatch(2)).toMatch(/restart this session/i);
  });
  it('uses the Codex turn metadata thread id', () => {
    const meta = { 'x-codex-turn-metadata': { thread_id: 't-1', session_id: 't-1' }, threadId: 't-1' };
    expect(callerFrom({}, meta, '/w')).toEqual({ provider: 'codex', providerSessionId: 't-1', cwd: '/w' });
  });
  it('prefers Codex metadata over a leaked Claude env var', () => {
    const meta = { 'x-codex-turn-metadata': { thread_id: 't-2' } };
    expect(callerFrom({ CLAUDE_CODE_SESSION_ID: 'c' }, meta, '/w').provider).toBe('codex');
  });
  it('uses CLAUDE_CODE_SESSION_ID for Claude', () => {
    expect(callerFrom({ CLAUDE_CODE_SESSION_ID: 'c-1', CLAUDE_PROJECT_DIR: '/proj' }, undefined, '/w'))
      .toEqual({ provider: 'claude', providerSessionId: 'c-1', cwd: '/proj' });
  });
  it('reports unknown identity otherwise', () => {
    expect(callerFrom({}, {}, '/w').providerSessionId).toBeNull();
  });
});

describe('SSE parsing', () => {
  it('yields JSON data events across chunk boundaries', async () => {
    const enc = new TextEncoder();
    const parts = ['data: {"type":"session-id","sessionId":"a"}\n', '\ndata: {"kind":"text"}\n\ndata: {"ty', 'pe":"done"}\n\n'];
    const body = new ReadableStream<Uint8Array>({ start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close(); } });
    const out = [];
    for await (const e of sseEvents(body)) out.push(e);
    expect(out).toEqual([{ type: 'session-id', sessionId: 'a' }, { kind: 'text' }, { type: 'done' }]);
  });
});

describe('activity capture', () => {
  it('updates a progressing tool call in place and drops consecutive repeats', () => {
    let list = pushActivity([], { toolId: 't1' }, 'Bash: ls', 'a');
    list = pushActivity(list, { toolId: 't1' }, 'Bash: ls (done)', 'b');
    list = pushActivity(list, {}, 'thinking', 'c');
    list = pushActivity(list, {}, 'thinking', 'd');
    expect(list.map((x) => x.text)).toEqual(['Bash: ls (done)', 'thinking']);
  });
});

describe('version', () => {
  it('is the same in package.json, manifest.json and the code', () => {
    for (const f of ['package.json', 'manifest.json']) expect(JSON.parse(fs.readFileSync(f, 'utf8')).version).toBe(VERSION);
  });
});

describe('database migration backups', () => {
  const oldSchema = `
    CREATE TABLE runs (id TEXT PRIMARY KEY, lead_agent_id TEXT, project_path TEXT, status TEXT, plan_status TEXT, created_at TEXT, ended_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, run_id TEXT, role TEXT, provider TEXT, provider_session_id TEXT, app_session_id TEXT, cwd TEXT, branch TEXT, worktree_path TEXT, status TEXT, task TEXT, result TEXT, last_error TEXT, created_at TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, run_id TEXT, from_agent TEXT, to_agent TEXT, kind TEXT, body TEXT, created_at TEXT, delivered_at TEXT);
    CREATE TABLE gates (id INTEGER PRIMARY KEY, run_id TEXT, kind TEXT, requested_by TEXT, subject_agent TEXT, payload TEXT, status TEXT, comment TEXT, created_at TEXT, decided_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY, run_id TEXT, agent_id TEXT, type TEXT, data TEXT, created_at TEXT);
    CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `;

  it('takes a consistent snapshot before an older schema is migrated and retains five', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-migration-'));
    const file = path.join(tmp, 'coagent.db');
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode = WAL; ${oldSchema}`);
    db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('preserved', 'from-wal');
    db.close();

    const backupsDir = path.join(tmp, 'backups');
    fs.mkdirSync(backupsDir);
    for (let i = 0; i < 5; i++) {
      const old = path.join(backupsDir, `coagent-old-${i}.db`);
      fs.writeFileSync(old, 'old');
      fs.utimesSync(old, i + 1, i + 1);
    }

    const store = new Store(file, () => new Date('2026-11-25T12:34:56.789Z'));
    store.close();
    const names = fs.readdirSync(backupsDir).sort();
    expect(names).toHaveLength(5);
    expect(names).toContain('coagent-20261125T123456789Z.db');
    expect(names).not.toContain('coagent-old-0.db');

    const snapshot = new DatabaseSync(path.join(backupsDir, 'coagent-20261125T123456789Z.db'), { readOnly: true });
    expect(snapshot.prepare("SELECT v FROM kv WHERE k = 'preserved'").get()).toEqual({ v: 'from-wal' });
    snapshot.close();
    const migrated = new DatabaseSync(file);
    expect(migrated.prepare('PRAGMA table_info(messages)').all().map((row) => row.name)).toContain('delivery_state');
    migrated.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('does not back up a current schema when there is nothing to migrate', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-current-'));
    const file = path.join(tmp, 'coagent.db');
    new Store(file).close();
    new Store(file).close();
    expect(fs.existsSync(path.join(tmp, 'backups'))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
