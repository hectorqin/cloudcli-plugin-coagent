import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertCleanupRoot, claudeProjectDirName, cleanupTempRoot, safeExisting, type CleanupBroker,
} from '../scripts/e2e-cleanup.mjs';

let base: string; // stands in for os.tmpdir()
let home: string;
let dbPath: string;
let claudeRoot: string;
let codexRoot: string;
let tempRoot: string;
let repo: string;

function write(file: string, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function db() {
  return new DatabaseSync(dbPath);
}

function addSession(id: string, projectPath: string, jsonlPath: string | null) {
  const d = db();
  d.prepare('INSERT INTO sessions (session_id, project_path, jsonl_path) VALUES (?,?,?)').run(id, projectPath, jsonlPath);
  d.prepare('INSERT INTO projects (project_id, project_path) VALUES (?,?)').run(`p-${id}`, projectPath);
  d.close();
}

function count(table: string, where = '1=1', ...params: string[]) {
  const d = db();
  const n = Number((d.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n);
  d.close();
  return n;
}

/** A broker with one run for the temp root; behaviour overridable per test. */
function fakeBroker(over: Partial<CleanupBroker> & { worktreePath?: string | null } = {}) {
  const run = { id: 'r-1', projectPath: repo, status: 'active' };
  const calls: string[] = [];
  const broker: CleanupBroker = {
    runs: async () => [run, { id: 'r-other', projectPath: path.join(base, 'elsewhere', 'repo'), status: 'active' }],
    endRun: async (id) => { calls.push(id); run.status = 'ended'; return { ok: true, failedWorktrees: [] }; },
    detail: async () => ({
      run: { status: run.status },
      agents: [
        { id: 'lead-1', provider: 'claude', cwd: repo, appSessionId: 'app-lead', providerSessionId: 'lead-sess', worktreePath: null },
        { id: 'coder-1', provider: 'claude', cwd: path.join(tempRoot, 'repo-worktrees', 'wt'), appSessionId: 'app-coder',
          providerSessionId: 'coder-sess', worktreePath: over.worktreePath ?? null },
      ],
    }),
    ...over,
  };
  return { broker, calls };
}

const idle = async () => false as boolean | null;

function opts(broker: CleanupBroker, sessionStatus = idle) {
  return { tempRoot, tmpDir: base, dbPath, claudeRoot, codexRoot, broker, sessionStatus, waitMs: 10, pollMs: 5, sleep: async () => undefined };
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cleanup-test-'));
  home = path.join(base, 'home');
  claudeRoot = path.join(home, '.claude', 'projects');
  codexRoot = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(codexRoot, { recursive: true });
  dbPath = path.join(home, 'auth.db');
  const d = db();
  d.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_path TEXT, jsonl_path TEXT);
    CREATE TABLE superseded_provider_sessions (provider_session_id TEXT, session_id TEXT, jsonl_path TEXT);
    CREATE TABLE scheduled_messages (id INTEGER PRIMARY KEY, session_id TEXT);
    CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT);`);
  d.close();
  tempRoot = fs.mkdtempSync(path.join(base, 'coagent-e2e-claude-'));
  repo = path.join(tempRoot, 'repo');
  fs.mkdirSync(repo);
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('e2e cleanup', () => {
  it('removes exactly the rows, transcripts and directories of its own root', async () => {
    const leadDir = path.join(claudeRoot, claudeProjectDirName(repo));
    const leadFile = write(path.join(leadDir, 'lead-sess.jsonl'));
    write(path.join(leadDir, 'lead-sess', 'subagents', 'a.jsonl')); // per-session artifacts
    const codexFile = write(path.join(codexRoot, '2026', '11', '26', 'rollout-x.jsonl'));
    addSession('lead-sess', repo, leadFile);
    addSession('coder-codex', path.join(tempRoot, 'repo-worktrees', 'wt'), codexFile);
    const d = db();
    d.prepare('INSERT INTO scheduled_messages (session_id) VALUES (?)').run('lead-sess');
    d.prepare('INSERT INTO superseded_provider_sessions (provider_session_id, session_id, jsonl_path) VALUES (?,?,?)').run('old', 'lead-sess', null);
    d.close();
    // The Claude coder has no CloudCLI row: its transcript is found through the run's own agent.
    const coderFile = write(path.join(claudeRoot, claudeProjectDirName(path.join(tempRoot, 'repo-worktrees', 'wt')), 'coder-sess.jsonl'));
    const unrelated = path.join(base, 'elsewhere', 'repo');
    const unrelatedFile = write(path.join(claudeRoot, claudeProjectDirName(unrelated), 'u.jsonl'));
    addSession('unrelated', unrelated, unrelatedFile);

    const { broker, calls } = fakeBroker();
    const res = await cleanupTempRoot(opts(broker));
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['r-1']); // never the other root's run
    expect(res.rows).toEqual({ scheduled_messages: 1, superseded_provider_sessions: 1, sessions: 2, projects: 2 });
    for (const gone of [leadFile, leadDir, codexFile, coderFile, path.dirname(coderFile), tempRoot]) expect(fs.existsSync(gone), gone).toBe(false);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
    expect(count('sessions', 'session_id = ?', 'unrelated')).toBe(1);
  });

  it('never scans by name prefix: a sibling whose name encodes to the same prefix is untouched', async () => {
    // e.g. /tmp/coagent-e2e-claude-abc123 vs /tmp/coagent-e2e-claude-abc123!victim
    const sibling = `${tempRoot}!victim`;
    const victimDir = path.join(claudeRoot, claudeProjectDirName(sibling));
    expect(path.basename(victimDir).startsWith(`${claudeProjectDirName(tempRoot)}-`)).toBe(true);
    const victimFile = write(path.join(victimDir, 'v.jsonl'));
    // Same lossy dir name as our repo, but another project's transcript in it: the dir must stay.
    const sharedDir = path.join(claudeRoot, claudeProjectDirName(repo));
    const ours = write(path.join(sharedDir, 'lead-sess.jsonl'));
    const foreign = write(path.join(sharedDir, 'someone-else.jsonl'));
    addSession('lead-sess', repo, ours);

    const res = await cleanupTempRoot(opts(fakeBroker().broker));
    expect(res.ok).toBe(true);
    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.existsSync(victimFile)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(res.kept).toContain(sharedDir);
  });

  it.each([
    ['the end-run call fails', { endRun: async () => { throw new Error('502'); } }, idle, /could not end run r-1: 502/],
    ['the broker kept a worktree', { endRun: async () => ({ ok: true, failedWorktrees: [{ agentId: 'coder-1', path: '/w', reason: 'still running' }] }) }, idle, /kept worktree \/w .*still running/],
    ['the run still records a worktree', { worktreePath: '/w' }, idle, /still records worktree \/w/],
    ['a session is still running', {}, async () => true, /still running a turn/],
    ['a session state is unknown', {}, async () => null, /cannot confirm that session .* is idle/],
    ['the broker is unreachable', { runs: async () => { throw new Error('ECONNREFUSED'); } }, idle, /could not list broker runs/],
  ])('deletes nothing when %s', async (_name, over, status, problem) => {
    const file = write(path.join(claudeRoot, claudeProjectDirName(repo), 'lead-sess.jsonl'));
    addSession('lead-sess', repo, file);
    const res = await cleanupTempRoot(opts(fakeBroker(over as Partial<CleanupBroker>).broker, status as typeof idle));
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(problem);
    expect(res.manual.join('\n')).toMatch(new RegExp(`remove ${tempRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(fs.existsSync(tempRoot)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(count('sessions')).toBe(1);
  });

  it('removes a project dir that holds only empty folders (Claude creates memory/), keeps one with files', async () => {
    const dir = path.join(claudeRoot, claudeProjectDirName(repo));
    addSession('lead-sess', repo, write(path.join(dir, 'lead-sess.jsonl')));
    fs.mkdirSync(path.join(dir, 'memory'));
    expect((await cleanupTempRoot(opts(fakeBroker().broker))).ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);

    tempRoot = fs.mkdtempSync(path.join(base, 'coagent-e2e-claude-'));
    repo = path.join(tempRoot, 'repo');
    const dir2 = path.join(claudeRoot, claudeProjectDirName(repo));
    addSession('lead-2', repo, write(path.join(dir2, 'lead-2.jsonl')));
    const note = write(path.join(dir2, 'memory', 'note.md'));
    const res = await cleanupTempRoot(opts(fakeBroker().broker));
    expect(res.kept).toContain(dir2);
    expect(fs.existsSync(note)).toBe(true);
  });

  it('waits for a session that is finishing its turn', async () => {
    let polls = 0;
    const res = await cleanupTempRoot(opts(fakeBroker().broker, async () => ++polls < 3));
    expect(res.ok).toBe(true);
    expect(fs.existsSync(tempRoot)).toBe(false);
  });

  it('does not follow symlinks out of the transcript roots', async () => {
    const outside = path.join(base, 'outside');
    const target = write(path.join(outside, 'lead-sess.jsonl'), 'precious');
    // A symlinked project dir inside the Claude root pointing elsewhere.
    fs.symlinkSync(outside, path.join(claudeRoot, claudeProjectDirName(repo)));
    addSession('lead-sess', repo, path.join(claudeRoot, claudeProjectDirName(repo), 'lead-sess.jsonl'));
    // A symlinked transcript file inside the Codex root.
    const codexTarget = write(path.join(outside, 'rollout.jsonl'), 'precious');
    const link = path.join(codexRoot, 'rollout-link.jsonl');
    fs.symlinkSync(codexTarget, link);
    addSession('codex-sess', repo, link);

    const res = await cleanupTempRoot(opts(fakeBroker().broker));
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/refusing to follow a symlink/);
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');
    expect(fs.readFileSync(codexTarget, 'utf8')).toBe('precious');
  });

  it('safeExisting rejects paths outside the root or through a symlink', () => {
    const inside = write(path.join(claudeRoot, 'd', 'f.jsonl'));
    expect(safeExisting(claudeRoot, inside)).toBe(fs.realpathSync(inside));
    expect(safeExisting(claudeRoot, path.join(claudeRoot, '..', 'x'))).toBeNull();
    expect(safeExisting(claudeRoot, path.join(claudeRoot, 'missing'))).toBeNull();
    fs.symlinkSync(path.join(claudeRoot, 'd'), path.join(claudeRoot, 'link'));
    expect(safeExisting(claudeRoot, path.join(claudeRoot, 'link', 'f.jsonl'))).toBeNull();
  });

  it('only accepts a real coagent-e2e-* directory directly under the temp dir', () => {
    expect(() => assertCleanupRoot(tempRoot, base)).not.toThrow();
    expect(() => assertCleanupRoot(path.join(base, 'other'), base)).toThrow(/unexpected temp root/);
    expect(() => assertCleanupRoot(path.join(tempRoot, 'coagent-e2e-nested'), base)).toThrow(/unexpected temp root/);
    const link = path.join(base, 'coagent-e2e-link');
    fs.symlinkSync(tempRoot, link);
    expect(() => assertCleanupRoot(link, base)).toThrow(/symlinked/);
  });

  it('cleans up a root whose fixture was never finished (no run, no rows)', async () => {
    write(path.join(repo, '.git', 'HEAD'), 'half-built');
    const res = await cleanupTempRoot(opts({ runs: async () => [], detail: async () => null, endRun: async () => ({ ok: true }) }));
    expect(res.ok).toBe(true);
    expect(fs.existsSync(tempRoot)).toBe(false);
  });
});
