/**
 * Cleanup for scripts/e2e.mjs, kept separate so it can be unit-tested (test/e2e-cleanup.test.ts).
 *
 * Rules:
 *  - Only a directory created by mkdtemp under os.tmpdir() and named coagent-e2e-* is ever a cleanup root.
 *  - Nothing is deleted unless every coagent run for the root ended, kept no worktree, and every session involved is
 *    confirmed idle. Anything uncertain keeps everything and returns manual steps instead.
 *  - Files and directories come only from DB rows that belong to the root, or from the run's own agents. Never from
 *    scanning by name prefix (Claude's directory names are lossy).
 *  - Every deletion target must resolve, without symlinks, inside its expected root.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Lexical containment (strictly inside, not equal). */
export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The real path of an existing `candidate` if it lies inside `root` with no symlink anywhere between them
 * (including `candidate` itself); otherwise null.
 */
export function safeExisting(root, candidate) {
  if (!isInside(root, candidate)) return null;
  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync(root);
    if (fs.lstatSync(candidate).isSymbolicLink()) return null;
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  const lexical = path.relative(path.resolve(root), path.resolve(candidate));
  return path.relative(realRoot, real) === lexical ? real : null;
}

/** Claude Code names a project's transcript dir after its cwd with every non-alphanumeric character replaced by '-'. */
export function claudeProjectDirName(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** True when `dir` holds nothing but (recursively) empty real directories: no files, no symlinks. */
function onlyEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !onlyEmptyDirs(path.join(dir, entry.name))) return false;
  }
  return true;
}

/** Throws unless `tempRoot` is a real (non-symlink) coagent-e2e-* directory directly under `tmpDir`. */
export function assertCleanupRoot(tempRoot, tmpDir = os.tmpdir()) {
  if (path.dirname(path.resolve(tempRoot)) !== path.resolve(tmpDir) || !path.basename(tempRoot).startsWith('coagent-e2e-')) {
    throw new Error(`refusing to clean up unexpected temp root: ${tempRoot}`);
  }
  if (fs.existsSync(tempRoot) && fs.lstatSync(tempRoot).isSymbolicLink()) {
    throw new Error(`refusing to clean up a symlinked temp root: ${tempRoot}`);
  }
}

function ownedDbRows(dbPath, tempRoot) {
  if (!fs.existsSync(dbPath)) return { sessions: [], superseded: [], projects: [] };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Matched in JS: LIKE's '_' and '%' wildcards could reach outside the temp root.
    const ours = (row) => isInside(tempRoot, String(row.project_path));
    const sessions = db.prepare('SELECT session_id, project_path, jsonl_path FROM sessions').all().filter(ours);
    const projects = db.prepare('SELECT project_id, project_path FROM projects').all().filter(ours);
    const ids = sessions.map((row) => String(row.session_id));
    const superseded = ids.length
      ? db.prepare(`SELECT session_id, jsonl_path FROM superseded_provider_sessions WHERE session_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    return { sessions, superseded, projects };
  } finally {
    db.close();
  }
}

function deleteDbRows(dbPath, rows) {
  const counts = { scheduled_messages: 0, superseded_provider_sessions: 0, sessions: 0, projects: 0 };
  if (!fs.existsSync(dbPath)) return counts;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { session_id: id } of rows.sessions) {
        counts.scheduled_messages += Number(db.prepare('DELETE FROM scheduled_messages WHERE session_id = ?').run(id).changes);
        counts.superseded_provider_sessions += Number(db.prepare('DELETE FROM superseded_provider_sessions WHERE session_id = ?').run(id).changes);
        counts.sessions += Number(db.prepare('DELETE FROM sessions WHERE session_id = ?').run(id).changes);
      }
      for (const { project_id: id } of rows.projects) counts.projects += Number(db.prepare('DELETE FROM projects WHERE project_id = ?').run(id).changes);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
  return counts;
}

/**
 * Exact transcript files to remove: jsonl paths of owned DB rows (Claude or Codex), plus the expected Claude
 * transcript of each of the run's own Claude agents (`<claudeRoot>/<encoded cwd>/<session id>.jsonl`).
 */
function transcriptCandidates(rows, agents, tempRoot, claudeRoot) {
  const files = new Set();
  for (const row of [...rows.sessions, ...rows.superseded]) if (row.jsonl_path) files.add(String(row.jsonl_path));
  for (const a of agents) {
    if (a.provider !== 'claude' || !a.providerSessionId || !a.cwd || !(a.cwd === tempRoot || isInside(tempRoot, a.cwd))) continue;
    if (!/^[\w-]+$/.test(a.providerSessionId)) continue;
    files.add(path.join(claudeRoot, claudeProjectDirName(a.cwd), `${a.providerSessionId}.jsonl`));
  }
  return [...files];
}

/**
 * Ends the runs of `tempRoot`, proves nothing is still working, then removes its CloudCLI rows, transcripts and the
 * root itself. Returns ok=false (having deleted nothing) with `problems` and `manual` steps when anything is uncertain.
 *
 * deps.broker: { runs(): Promise<RunSummary[]>, detail(runId): Promise<RunDetail|null>, endRun(runId): Promise<object> }
 * deps.sessionStatus(id): Promise<boolean|null> — true = a turn is running, false = idle/unknown to CloudCLI, null = cannot tell.
 */
export async function cleanupTempRoot({
  tempRoot, tmpDir = os.tmpdir(), dbPath, claudeRoot, codexRoot, broker, sessionStatus, captured = [],
  waitMs = 60_000, pollMs = 2_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  assertCleanupRoot(tempRoot, tmpDir);
  const problems = [];
  const removed = [];
  const kept = [];
  const endedRuns = [];
  const agents = [...captured];

  // 1. End every run of this root, and prove each kept no worktree.
  let runs = [];
  try {
    runs = (await broker.runs()).filter((run) => isInside(tempRoot, String(run.projectPath)));
  } catch (error) {
    problems.push(`could not list broker runs: ${error.message}`);
  }
  for (const run of runs) {
    try {
      if (run.status === 'active') {
        const res = await broker.endRun(run.id);
        if (res?.ok !== true) throw new Error(`end returned ${JSON.stringify(res).slice(0, 200)}`);
        if (Array.isArray(res.failedWorktrees) && res.failedWorktrees.length) {
          for (const f of res.failedWorktrees) problems.push(`run ${run.id} kept worktree ${f.path} (${f.agentId}): ${f.reason ?? f.error}`);
        }
        endedRuns.push(run.id);
      }
      const detail = await broker.detail(run.id);
      if (!detail) throw new Error('run detail is missing');
      if (detail.run.status !== 'ended') problems.push(`run ${run.id} is still ${detail.run.status}`);
      for (const a of detail.agents) {
        agents.push(a);
        if (a.worktreePath) problems.push(`run ${run.id} still records worktree ${a.worktreePath} for ${a.id}`);
      }
    } catch (error) {
      problems.push(`could not end run ${run.id}: ${error.message}`);
    }
  }

  // 2. Every session involved must be confirmed idle (waiting a little for one that is finishing).
  let rows = { sessions: [], superseded: [], projects: [] };
  try {
    rows = ownedDbRows(dbPath, tempRoot);
  } catch (error) {
    problems.push(`could not read CloudCLI rows: ${error.message}`);
  }
  const sessionIds = new Set([
    ...rows.sessions.map((row) => String(row.session_id)),
    ...agents.flatMap((a) => [a.appSessionId, a.providerSessionId]).filter(Boolean).map(String),
  ]);
  for (const id of sessionIds) {
    let state = await sessionStatus(id).catch(() => null);
    for (let waited = 0; state === true && waited < waitMs; waited += pollMs) {
      await sleep(pollMs);
      state = await sessionStatus(id).catch(() => null);
    }
    if (state === true) problems.push(`session ${id} is still running a turn`);
    else if (state !== false) problems.push(`cannot confirm that session ${id} is idle`);
  }

  if (problems.length) {
    kept.push(tempRoot);
    return { ok: false, endedRuns, rows: {}, removed, kept, problems, manual: manualSteps(tempRoot, runs, rows) };
  }

  // 3. Delete exactly what belongs to the root.
  const counts = deleteDbRows(dbPath, rows);
  const projectDirs = new Set();
  for (const file of transcriptCandidates(rows, agents, tempRoot, claudeRoot)) {
    const inClaude = isInside(claudeRoot, file);
    const root = inClaude ? claudeRoot : isInside(codexRoot, file) ? codexRoot : null;
    if (!root || !file.endsWith('.jsonl')) { kept.push(file); problems.push(`not a transcript under the Claude/Codex roots: ${file}`); continue; }
    if (!fs.existsSync(file)) continue;
    if (!safeExisting(root, file) || !fs.lstatSync(file).isFile()) { kept.push(file); problems.push(`refusing to follow a symlink: ${file}`); continue; }
    fs.rmSync(file);
    removed.push(file);
    if (inClaude) {
      // Claude keeps per-session artifacts in a sibling dir named after the session id.
      const artifacts = file.slice(0, -'.jsonl'.length);
      if (fs.existsSync(artifacts)) {
        if (safeExisting(claudeRoot, artifacts) && fs.lstatSync(artifacts).isDirectory()) {
          fs.rmSync(artifacts, { recursive: true, force: true });
          removed.push(artifacts);
        } else { kept.push(artifacts); problems.push(`refusing to follow a symlink: ${artifacts}`); }
      }
      if (path.dirname(path.dirname(file)) === path.resolve(claudeRoot)) projectDirs.add(path.dirname(file));
    }
  }
  // A Claude project dir goes only when no file is left in it (another project may share the lossy name).
  // Claude Code also creates empty folders there (e.g. memory/), which go with it.
  for (const dir of projectDirs) {
    if (!fs.existsSync(dir) || !safeExisting(claudeRoot, dir)) continue;
    if (!onlyEmptyDirs(dir)) { kept.push(dir); continue; }
    fs.rmSync(dir, { recursive: true });
    removed.push(dir);
  }
  if (fs.existsSync(tempRoot)) {
    assertCleanupRoot(tempRoot, tmpDir);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    removed.push(tempRoot);
  }
  return { ok: problems.length === 0, endedRuns, rows: counts, removed, kept, problems, manual: problems.length ? manualSteps(tempRoot, runs, rows) : [] };
}

function manualSteps(tempRoot, runs, rows) {
  const steps = [];
  for (const run of runs) steps.push(`end run ${run.id} in the CoAgent tab (with worktree removal) once its agents are idle`);
  if (rows.sessions.length || rows.projects.length) {
    steps.push(`delete the CloudCLI rows for ${tempRoot}: sessions ${rows.sessions.map((r) => r.session_id).join(', ') || '-'}; `
      + `projects ${rows.projects.map((r) => r.project_id).join(', ') || '-'} (plus their superseded_provider_sessions/scheduled_messages)`);
  }
  for (const row of [...rows.sessions, ...rows.superseded]) if (row.jsonl_path) steps.push(`remove transcript ${row.jsonl_path}`);
  steps.push(`remove ${tempRoot} (rm -rf) after checking nothing still uses it`);
  return steps;
}
