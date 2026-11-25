#!/usr/bin/env node

/**
 * Real CloudCLI acceptance test. This is intentionally a hand-run script: it creates
 * live Claude/Codex sessions and approves their coagent gates through the tab API.
 */
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const CLOUDCLI_URL = 'http://127.0.0.1:3001';
const PROVIDERS = ['claude', 'codex'];
const POLL_MS = 2_000;
const GATE_BLOCK_MS = 4_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const NO_RUN_GRACE_MS = 30_000;

function parseArgs(argv) {
  let providers = [...PROVIDERS];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider') {
      const provider = argv[++i];
      if (!PROVIDERS.includes(provider)) throw new Error(`--provider must be one of: ${PROVIDERS.join(', ')}`);
      providers = [provider];
    } else if (argv[i] === '--timeout-minutes') {
      const minutes = Number(argv[++i]);
      if (!(minutes > 0 && minutes <= 15)) throw new Error('--timeout-minutes must be greater than 0 and at most 15');
      timeoutMs = minutes * 60_000;
    } else if (argv[i] === '--help') {
      console.log('Usage: node scripts/e2e.mjs [--provider claude|codex] [--timeout-minutes 1..15]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return { providers, timeoutMs };
}

function readConfig() {
  const home = os.homedir();
  const plugins = JSON.parse(fs.readFileSync(path.join(home, '.claude-code-ui', 'plugins.json'), 'utf8'));
  const apiKey = plugins?.coagent?.secrets?.apiKey;
  assert.equal(typeof apiKey, 'string', 'coagent plugin secret apiKey is not configured');
  assert.ok(apiKey.length > 0, 'coagent plugin secret apiKey is empty');
  const runtime = JSON.parse(fs.readFileSync(path.join(home, '.cloudcli-coagent', 'runtime.json'), 'utf8'));
  assert.ok(Number.isInteger(runtime.port) && runtime.port > 0, 'coagent runtime port is invalid');
  return { apiKey, brokerUrl: `http://127.0.0.1:${runtime.port}` };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });
}

function deadlineSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`provider timed out after ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs);
  timer.unref();
  return { controller, clear: () => clearTimeout(timer) };
}

async function git(cwd, ...args) {
  const { stdout } = await execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function makeRepo(provider) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `coagent-e2e-${provider}-`));
  const repo = path.join(tempRoot, 'repo');
  fs.mkdirSync(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'coagent e2e fixture\n');
  await git(repo, 'add', 'README.md');
  await git(repo, '-c', 'user.name=coagent-e2e', '-c', 'user.email=coagent-e2e@localhost', 'commit', '-q', '-m', 'fixture');
  return { tempRoot, repo, worktreeContainer: `${repo}-worktrees` };
}

async function jsonRequest(url, apiKey, { method = 'GET', body, signal } = {}) {
  const headers = { 'x-plugin-secret-apikey': apiKey };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname} returned ${response.status}: ${parsed.error ?? JSON.stringify(parsed)}`);
  return parsed;
}

function leadPrompt(provider) {
  return `Run a real coagent acceptance task. You must use the coagent MCP tools and follow this exact sequence:
1. Call submit_plan with a plan to delegate the single file change below to exactly ONE coder.
2. After approval, spawn exactly one coder. The coder must add hello.txt containing exactly the bytes "hello from coagent" with no trailing newline, commit if appropriate, and report_result.
3. Call wait_for_agents and wait until that coder reports. If it returns early while the coder is still working, call it again.
4. Call request_merge for that coder. After approval, verify the merge succeeded. Call end_agent only if the worker was not already ended by the merge.
5. Give a concise final summary.

Do not edit the file yourself. Do not spawn planners, reviewers, testers, or additional coders. The lead provider is ${provider}.`;
}

async function startLead(provider, repo, apiKey, signal) {
  const response = await fetch(`${CLOUDCLI_URL}/api/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      projectPath: repo,
      provider,
      message: leadPrompt(provider),
      stream: true,
      ...(provider === 'claude' ? { unattended: false } : {}),
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`CloudCLI lead start returned ${response.status}: ${detail.slice(0, 300)}`);
  }
  // Draining the SSE body is required, but state and gate polling must proceed concurrently.
  const stream = { done: false, error: null };
  const bodyDone = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let tail = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Model output is never printed; only an error event's short message is kept for the FAIL line.
        tail = (tail + decoder.decode(value, { stream: true })).slice(-4096);
        if (!stream.error) {
          const m = tail.match(/"type"\s*:\s*"error"[^\n]*?"(?:error|message)"\s*:\s*"([^"]{0,200})/);
          if (m) stream.error = m[1];
        }
      }
    } finally {
      stream.done = true;
      reader.releaseLock();
    }
  })();
  // Wrap the promise: returning it directly from this async function would make
  // the caller wait for the entire lead turn before it could start gate polling.
  return { bodyDone, stream };
}

function findOurRun(state, repo) {
  return state.runs.find((run) => run.projectPath === repo) ?? null;
}

async function exerciseProvider(provider, timeoutMs) {
  const started = Date.now();
  const { apiKey, brokerUrl } = readConfig();
  const created = await makeRepo(provider);
  const { controller, clear } = deadlineSignal(timeoutMs);
  let runId = null;
  let leadBody = null;
  let leadStream = null;
  let streamEndedAt = null;
  let workerPath = null;
  let mergeDiffChecked = false;
  const decided = new Set();
  let stableCompletePolls = 0;

  try {
    ({ bodyDone: leadBody, stream: leadStream } = await startLead(provider, created.repo, apiKey, controller.signal));
    leadBody.catch(() => undefined); // awaited in finally; avoid an unhandled rejection on abort
    while (!controller.signal.aborted) {
      const summary = await jsonRequest(`${brokerUrl}/state`, apiKey, { signal: controller.signal });
      const found = runId ? summary.runs.find((run) => run.id === runId) : findOurRun(summary, created.repo);
      if (found && !runId) runId = found.id;
      if (!runId) {
        // A lead whose first turn ended without ever calling submit_plan will never create a run.
        if (leadStream.done) {
          streamEndedAt ??= Date.now();
          if (Date.now() - streamEndedAt > NO_RUN_GRACE_MS) {
            throw new Error(`lead turn ended without creating a coagent run${leadStream.error ? `: ${leadStream.error}` : ''}`);
          }
        }
        await sleep(POLL_MS, controller.signal);
        continue;
      }

      const state = await jsonRequest(`${brokerUrl}/state?run=${encodeURIComponent(runId)}`, apiKey, { signal: controller.signal });
      const detail = state.current;
      assert.ok(detail, `run ${runId} disappeared from broker state`);
      const worker = detail.agents.find((agent) => agent.role !== 'lead');
      if (worker?.worktreePath) workerPath = worker.worktreePath;
      assert.ok(detail.agents.filter((agent) => agent.role !== 'lead').length <= 1, 'lead spawned more than one worker');

      for (const gate of detail.gates.filter((item) => item.status === 'pending' && !decided.has(item.id))) {
        const age = Date.now() - Date.parse(gate.createdAt);
        if (age < GATE_BLOCK_MS) continue; // prove the lead really remained blocked for a visible interval
        if (gate.kind === 'merge') {
          const diff = await jsonRequest(`${brokerUrl}/gates/${gate.id}/diff`, apiKey, { signal: controller.signal });
          assert.match(diff.diff, /hello\.txt/, 'merge gate diff does not mention hello.txt');
          mergeDiffChecked = true;
        }
        await jsonRequest(`${brokerUrl}/gates/${gate.id}`, apiKey, {
          method: 'POST', body: { approve: true, comment: `approved by ${provider} acceptance test` }, signal: controller.signal,
        });
        decided.add(gate.id);
      }

      const types = new Set(detail.events.map((event) => event.type));
      const merged = detail.events.some((event) => event.type === 'merge' && event.data?.ok === true);
      const pendingMessage = detail.messages.some((message) => ['queued', 'dispatching'].includes(message.state));
      const noPendingGate = detail.gates.every((gate) => gate.status !== 'pending');
      const leadBusy = detail.agents.find((agent) => agent.role === 'lead')?.busy === true;
      const complete = merged && mergeDiffChecked && noPendingGate && !pendingMessage && !leadBusy && types.has('turn_end');
      stableCompletePolls = complete ? stableCompletePolls + 1 : 0;
      // A Claude lead finishes the whole flow in its first (streamed) turn; let it end on its own
      // instead of aborting the stream, so no CLI process is left writing into a deleted directory.
      if (stableCompletePolls >= 2 && leadStream.done) {
        await assertOutcome(detail, created, workerPath);
        return { provider, ok: true, durationMs: Date.now() - started, runId, created };
      }
      await sleep(POLL_MS, controller.signal);
    }
    throw controller.signal.reason;
  } finally {
    clear();
    controller.abort();
    if (leadBody) await leadBody.catch(() => undefined);
    await cleanup({ tempRoot: created.tempRoot, runId, brokerUrl, apiKey });
  }
}

async function assertOutcome(detail, created, workerPath) {
  assert.equal(detail.agents.filter((agent) => agent.role !== 'lead').length, 1, 'expected exactly one worker');
  const worker = detail.agents.find((agent) => agent.role !== 'lead');
  assert.equal(worker.status, 'merged', `worker did not reach merged status (was ${worker.status})`);
  assert.equal(worker.worktreePath, null, 'merged worker retained its worktree path');
  assert.ok(workerPath, 'worker worktree path was never observed');
  assert.ok(path.resolve(workerPath).startsWith(`${path.resolve(created.tempRoot)}${path.sep}`), 'worker path escaped the temporary root');
  assert.equal(fs.existsSync(workerPath), false, 'worker worktree still exists on disk');
  assert.equal(await git(created.repo, 'branch', '--show-current'), 'main', 'fixture is no longer on main');
  const hello = fs.readFileSync(path.join(created.repo, 'hello.txt'), 'utf8');
  assert.ok(hello === 'hello from coagent' || hello === 'hello from coagent\n', `hello.txt content is incorrect: ${JSON.stringify(hello.slice(0, 80))}`);
  const mergeCommit = await git(created.repo, 'log', '--merges', '-1', '--format=%H', 'main');
  assert.match(await git(created.repo, 'diff', '--name-only', `${mergeCommit}^1`, mergeCommit), /^hello\.txt$/m, 'the merge commit does not bring in hello.txt');
  assert.ok(Number(await git(created.repo, 'rev-list', '--count', '--merges', 'main')) >= 1, 'main has no merge commit');
  assert.ok(!(await git(created.repo, 'worktree', 'list', '--porcelain')).includes(workerPath), 'git still registers the worker worktree');

  const types = new Set(detail.events.map((event) => event.type));
  for (const required of ['run_started', 'gate_opened', 'gate_decided', 'spawned', 'turn_start', 'turn_end', 'wait_start', 'wait_end', 'merge']) {
    assert.ok(types.has(required), `timeline is missing ${required}`);
  }
  assert.ok(detail.gates.some((gate) => gate.kind === 'plan' && gate.status === 'approved'), 'plan gate was not approved');
  assert.ok(detail.gates.some((gate) => gate.kind === 'merge' && gate.status === 'approved'), 'merge gate was not approved');
  assert.equal(detail.messages.filter((message) => ['queued', 'dispatching'].includes(message.state)).length, 0, 'messages remain queued or dispatching');
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function sqlPlaceholders(values) {
  return values.map(() => '?').join(',');
}

/** Claude Code names a project's transcript dir after its cwd with every non-alphanumeric character replaced by '-'. */
function claudeProjectDirName(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function cleanupCloudCli(tempRoot) {
  const home = os.homedir();
  const dbPath = path.join(home, '.cloudcli', 'auth.db');
  const claudeRoot = path.join(home, '.claude', 'projects');
  const codexRoot = path.join(home, '.codex', 'sessions');
  const result = { rows: {}, transcripts: [], claudeDirs: [] };
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 10000');
      // Match in JS rather than with LIKE, whose '_' and '%' wildcards could reach outside the temp root.
      const ours = (row) => isInside(tempRoot, String(row.project_path));
      const sessions = db.prepare('SELECT session_id, project_path, jsonl_path FROM sessions').all().filter(ours);
      const projects = db.prepare('SELECT project_id, project_path FROM projects').all().filter(ours);
      const sessionIds = sessions.map((row) => String(row.session_id));
      const superseded = sessionIds.length
        ? db.prepare(`SELECT jsonl_path FROM superseded_provider_sessions WHERE session_id IN (${sqlPlaceholders(sessionIds)})`).all(...sessionIds)
        : [];
      const counts = { scheduled_messages: 0, superseded_provider_sessions: 0, sessions: 0, projects: 0 };
      db.exec('BEGIN IMMEDIATE');
      try {
        if (sessionIds.length) {
          const ph = sqlPlaceholders(sessionIds);
          counts.scheduled_messages = Number(db.prepare(`DELETE FROM scheduled_messages WHERE session_id IN (${ph})`).run(...sessionIds).changes);
          counts.superseded_provider_sessions = Number(db.prepare(`DELETE FROM superseded_provider_sessions WHERE session_id IN (${ph})`).run(...sessionIds).changes);
          counts.sessions = Number(db.prepare(`DELETE FROM sessions WHERE session_id IN (${ph})`).run(...sessionIds).changes);
        }
        for (const row of projects) counts.projects += Number(db.prepare('DELETE FROM projects WHERE project_id = ?').run(row.project_id).changes);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      result.rows = counts;
      const transcripts = [...new Set([...sessions, ...superseded].map((row) => row.jsonl_path && String(row.jsonl_path)).filter(Boolean))];
      for (const file of transcripts) {
        if (!isInside(claudeRoot, file) && !isInside(codexRoot, file)) {
          console.error(`cleanup warning: not removing transcript outside ${claudeRoot} and ${codexRoot}: ${file}`);
          continue;
        }
        if (fs.existsSync(file)) { fs.rmSync(file); result.transcripts.push(file); }
      }
    } finally {
      db.close();
    }
  }
  // Every Claude transcript dir for a path under the temp root (lead repo and worker worktrees) shares this prefix.
  const prefix = `${claudeProjectDirName(tempRoot)}-`;
  if (fs.existsSync(claudeRoot)) {
    for (const name of fs.readdirSync(claudeRoot)) {
      if (!name.startsWith(prefix)) continue;
      const dir = path.join(claudeRoot, name);
      fs.rmSync(dir, { recursive: true, force: true });
      result.claudeDirs.push(dir);
    }
  }
  return result;
}

async function cleanup({ tempRoot, runId, brokerUrl, apiKey }) {
  // Only ever touch a directory this script created with mkdtemp under os.tmpdir().
  if (path.dirname(path.resolve(tempRoot)) !== path.resolve(os.tmpdir()) || !path.basename(tempRoot).startsWith('coagent-e2e-')) {
    throw new Error(`refusing to clean up unexpected temp root: ${tempRoot}`);
  }
  const removed = { runs: [], rows: {}, transcripts: [], claudeDirs: [], paths: [] };
  try {
    // The run may have been created after the last poll, so look it up again by project path.
    const summary = await jsonRequest(`${brokerUrl}/state`, apiKey);
    const ids = new Set(summary.runs.filter((run) => run.status === 'active' && isInside(tempRoot, run.projectPath)).map((run) => run.id));
    if (runId && summary.runs.some((run) => run.id === runId && run.status === 'active')) ids.add(runId);
    for (const id of ids) {
      await jsonRequest(`${brokerUrl}/runs/${encodeURIComponent(id)}/end`, apiKey, { method: 'POST', body: { removeWorktrees: true } });
      removed.runs.push(id);
    }
  } catch (error) {
    console.error(`cleanup warning: could not end run(s) for ${tempRoot}: ${error.message}`);
  }
  try {
    Object.assign(removed, cleanupCloudCli(tempRoot));
  } catch (error) {
    console.error(`cleanup warning: CloudCLI row/transcript cleanup failed: ${error.message}`);
  }
  if (fs.existsSync(tempRoot)) { fs.rmSync(tempRoot, { recursive: true, force: true }); removed.paths.push(tempRoot); }
  console.log(`CLEAN ${path.basename(tempRoot)}: endedRuns=${removed.runs.join(',') || 'none'} rows=${JSON.stringify(removed.rows)}`);
  for (const file of [...removed.transcripts, ...removed.claudeDirs, ...removed.paths]) console.log(`  removed ${file}`);
}

const { providers, timeoutMs } = parseArgs(process.argv.slice(2));
const results = [];
for (const provider of providers) {
  const started = Date.now();
  try {
    const result = await exerciseProvider(provider, timeoutMs);
    results.push(result);
    console.log(`PASS ${provider} ${(result.durationMs / 1000).toFixed(1)}s run=${result.runId}`);
  } catch (error) {
    results.push({ provider, ok: false, durationMs: Date.now() - started, error });
    console.error(`FAIL ${provider} ${((Date.now() - started) / 1000).toFixed(1)}s ${error.stack ?? error}`);
  }
}
console.log(`SUMMARY ${results.map((result) => `${result.provider}:${result.ok ? 'PASS' : 'FAIL'}:${(result.durationMs / 1000).toFixed(1)}s`).join(' ')}`);
if (results.some((result) => !result.ok)) process.exitCode = 1;
