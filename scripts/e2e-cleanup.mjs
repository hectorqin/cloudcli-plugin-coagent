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
  beforeDelete, // test hook: runs between planning and deleting
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

  // 3. Preflight: validate every deletion target before deleting anything.
  const plan = planDeletions({ rows, agents, tempRoot, tmpDir, claudeRoot, codexRoot });
  if (plan.problems.length) {
    return {
      ok: false, endedRuns, rows: {}, removed, kept: [...plan.kept, tempRoot], problems: plan.problems,
      manual: manualSteps(tempRoot, runs, rows),
    };
  }

  // 4. Delete exactly the planned targets, re-checking each one (things can change between plan and delete).
  await beforeDelete?.();
  const done = executeDeletions({ dbPath, rows, plan, claudeRoot, codexRoot, tmpDir });
  return {
    ok: done.problems.length === 0, endedRuns, rows: done.counts, removed: done.removed, kept: done.kept, problems: done.problems,
    manual: done.problems.length ? manualSteps(tempRoot, runs, rows) : [],
  };
}

const zeroCounts = () => ({ scheduled_messages: 0, superseded_provider_sessions: 0, sessions: 0, projects: 0 });

/** Problems with any planned filesystem target as it is now (empty = all still valid). */
function revalidate(plan, { claudeRoot, codexRoot, tmpDir }) {
  const problems = [];
  const present = (p) => fs.existsSync(p) || isSymlink(p);
  for (const file of plan.files) {
    const root = isInside(claudeRoot, file) ? claudeRoot : codexRoot;
    if (present(file) && !(safeExisting(root, file) && fs.lstatSync(file).isFile())) problems.push(`changed since it was checked: ${file}`);
  }
  for (const dir of [...plan.artifactDirs, ...plan.projectDirs]) {
    if (present(dir) && !(safeExisting(claudeRoot, dir) && fs.lstatSync(dir).isDirectory())) problems.push(`changed since it was checked: ${dir}`);
  }
  if (plan.root && present(plan.root)) {
    try { assertCleanupRoot(plan.root, tmpDir); } catch (error) { problems.push(error.message); }
  }
  return problems;
}

/** Removes `dir` only if it holds nothing but (recursively) empty directories; rmdir only, never a recursive delete. */
function removeEmptyTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !removeEmptyTree(path.join(dir, entry.name))) return false;
  }
  fs.rmdirSync(dir);
  return true;
}

/**
 * Deletes the planned rows and paths. The DB rows are deleted inside one BEGIN IMMEDIATE transaction, each
 * conditioned on the ownership fields read during planning, and committed only after the filesystem work succeeded.
 * Any mismatch or change found on the way rolls the rows back and stops: the result is incomplete, never a guess.
 */
function executeDeletions({ dbPath, rows, plan, claudeRoot, codexRoot, tmpDir }) {
  const counts = zeroCounts();
  const removed = [];
  const kept = [...plan.kept];
  const problems = [];
  const db = fs.existsSync(dbPath) ? new DatabaseSync(dbPath) : null;
  try {
    db?.exec('PRAGMA busy_timeout = 10000');
    db?.exec('BEGIN IMMEDIATE');
    if (db) {
      for (const row of rows.sessions) {
        const n = Number(db.prepare('DELETE FROM sessions WHERE session_id = ? AND project_path = ? AND jsonl_path IS ?')
          .run(row.session_id, row.project_path, row.jsonl_path ?? null).changes);
        if (n !== 1) { problems.push(`CloudCLI session ${row.session_id} changed since it was checked`); continue; }
        counts.sessions += n;
        counts.scheduled_messages += Number(db.prepare('DELETE FROM scheduled_messages WHERE session_id = ?').run(row.session_id).changes);
      }
      for (const row of rows.superseded) {
        counts.superseded_provider_sessions += Number(db.prepare('DELETE FROM superseded_provider_sessions WHERE session_id = ? AND jsonl_path IS ?')
          .run(row.session_id, row.jsonl_path ?? null).changes);
      }
      for (const row of rows.projects) {
        const n = Number(db.prepare('DELETE FROM projects WHERE project_id = ? AND project_path = ?').run(row.project_id, row.project_path).changes);
        if (n !== 1) problems.push(`CloudCLI project ${row.project_id} changed since it was checked`);
        else counts.projects += n;
      }
    }
    if (!problems.length) problems.push(...revalidate(plan, { claudeRoot, codexRoot, tmpDir }));
    if (!problems.length) {
      // Each target is checked again right before it goes.
      for (const file of plan.files) {
        if (!fs.existsSync(file) && !isSymlink(file)) continue; // already gone
        const root = isInside(claudeRoot, file) ? claudeRoot : codexRoot;
        if (!(safeExisting(root, file) && fs.lstatSync(file).isFile())) { problems.push(`changed while deleting: ${file}`); break; }
        fs.rmSync(file);
        removed.push(file);
      }
    }
    if (!problems.length) {
      for (const dir of plan.artifactDirs) {
        if (!fs.existsSync(dir) && !isSymlink(dir)) continue;
        if (!(safeExisting(claudeRoot, dir) && fs.lstatSync(dir).isDirectory())) { problems.push(`changed while deleting: ${dir}`); break; }
        fs.rmSync(dir, { recursive: true }); // a planned per-session artifact dir (rm does not follow symlinks inside)
        removed.push(dir);
      }
    }
    if (!problems.length) {
      for (const dir of plan.projectDirs) {
        if (!fs.existsSync(dir)) continue;
        if (!safeExisting(claudeRoot, dir)) { problems.push(`changed while deleting: ${dir}`); break; }
        if (removeEmptyTree(dir)) removed.push(dir); else kept.push(dir); // something new appeared: keep it
      }
    }
    if (!problems.length && plan.root && fs.existsSync(plan.root)) {
      assertCleanupRoot(plan.root, tmpDir);
      fs.rmSync(plan.root, { recursive: true, force: true });
      removed.push(plan.root);
    }
    if (problems.length) {
      db?.exec('ROLLBACK');
      return { counts: zeroCounts(), removed, kept: [...kept, ...(plan.root && fs.existsSync(plan.root) ? [plan.root] : [])], problems };
    }
    db?.exec('COMMIT');
    return { counts, removed, kept, problems };
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    return { counts: zeroCounts(), removed, kept, problems: [...problems, `cleanup failed: ${error.message}`] };
  } finally {
    db?.close();
  }
}

/**
 * Everything cleanup would delete, all validated up front: transcript files, Claude per-session artifact dirs,
 * Claude project dirs that would be left without files, and the root. Any invalid target is a problem, and then
 * nothing at all is deleted. A project dir that still holds someone else's files is merely kept.
 */
function planDeletions({ rows, agents, tempRoot, tmpDir, claudeRoot, codexRoot }) {
  const problems = [];
  const kept = [];
  const files = [];
  const artifactDirs = [];
  const projectDirs = new Map(); // dir → names planned for deletion inside it
  for (const file of transcriptCandidates(rows, agents, tempRoot, claudeRoot)) {
    const inClaude = isInside(claudeRoot, file);
    const root = inClaude ? claudeRoot : isInside(codexRoot, file) ? codexRoot : null;
    if (!root || !file.endsWith('.jsonl')) { problems.push(`not a transcript under the Claude/Codex roots: ${file}`); continue; }
    if (!fs.existsSync(file) && !isSymlink(file)) continue;
    if (!safeExisting(root, file) || !fs.lstatSync(file).isFile()) { problems.push(`refusing to follow a symlink: ${file}`); continue; }
    files.push(file);
    if (!inClaude) continue;
    const dir = path.dirname(file);
    const planned = projectDirs.get(dir) ?? new Set();
    planned.add(path.basename(file));
    // Claude keeps per-session artifacts in a sibling dir named after the session id.
    const artifacts = file.slice(0, -'.jsonl'.length);
    if (fs.existsSync(artifacts) || isSymlink(artifacts)) {
      if (safeExisting(claudeRoot, artifacts) && fs.lstatSync(artifacts).isDirectory()) {
        artifactDirs.push(artifacts);
        planned.add(path.basename(artifacts));
      } else problems.push(`refusing to follow a symlink: ${artifacts}`);
    }
    if (path.dirname(dir) === path.resolve(claudeRoot)) projectDirs.set(dir, planned);
  }
  // A Claude project dir goes only when no file would be left in it (another project may share the lossy name).
  // Claude Code also creates empty folders there (e.g. memory/), which go with it.
  const removableDirs = [];
  for (const [dir, planned] of projectDirs) {
    if (!safeExisting(claudeRoot, dir)) { problems.push(`refusing to follow a symlink: ${dir}`); continue; }
    const leftover = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !planned.has(e.name) && !(e.isDirectory() && onlyEmptyDirs(path.join(dir, e.name))));
    if (leftover.length) kept.push(dir); else removableDirs.push(dir);
  }
  let root = null;
  if (fs.existsSync(tempRoot) || isSymlink(tempRoot)) {
    try { assertCleanupRoot(tempRoot, tmpDir); root = tempRoot; } catch (error) { problems.push(error.message); }
  }
  return { problems, kept, files, artifactDirs, projectDirs: removableDirs, root };
}

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
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
