import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolError, type Broker } from '../src/broker/broker.js';
import { HttpCloudCli } from '../src/broker/cloudcli.js';
import { redact, writeLog } from '../src/broker/log.js';
import { createHandler, secureDataPaths, startupFailureJson } from '../src/broker/server.js';
import { Store } from '../src/broker/store.js';

class StubCloudCli extends HttpCloudCli {
  saved: string[] = [];
  apiKeyConfigured() { return false; }
  verifyApiKey(candidate: string) { return candidate === 'tab-key'; }
  async saveApiKey(candidate: string) { this.saved.push(candidate); }
  async health() { return { ok: true, status: 200 }; }
}

const fakeBroker = {
  roleProviders: () => ({}),
  state: () => ({}),
  handleTool: async () => ({ ok: true, text: 'ok' }),
  decideGate: () => { throw new ToolError('Gate #3 is already approved.', 409); },
  gateDiff: (id: number) => {
    if (id === 9) throw new ToolError('Gate #9 has no code snapshot.');
    return { gate: id, diff: 'diff --git a/a b/a', truncated: false };
  },
  userMessage: () => 'Waiting for a worker slot.',
  endAgent: async (id: string, removeWorktree: boolean) => `Ended ${id}; remove=${removeWorktree}.`,
  resumeWorker: (id: string, by: string) => {
    if (id === 'coder-busy') throw new ToolError('coder-busy is busy; try again when its turn is over.', 409);
    return `Resumed ${id} by ${by}.`;
  },
  cancelAutoResume: (id: string) => `Cancelled the auto-resume of ${id}; the lead was told.`,
  quotaBackoffMinutes: () => 30,
  deleteMergedBranches: (runId: string, agentId: string) => {
    if (agentId !== 'lead') throw new ToolError('Only the lead can delete run branches.', 403);
    return { deleted: [{ agentId: 'coder-1', branch: `coagent/${runId}/coder-1` }], skipped: [] };
  },
  recordWorkspaceEvent: () => ({ ok: true }),
  endRun: async (id: string, removeWorktrees: boolean) => ({
    failedWorktrees: removeWorktrees ? [{ agentId: 'coder-1', path: `/wt/${id}`, reason: 'still running' }] : [],
  }),
} as unknown as Broker;

describe('broker HTTP hardening and diagnostics', () => {
  let tmp: string;
  let store: Store;
  let cloudcli: StubCloudCli;
  let server: http.Server;
  let port: number;
  let clock: number;
  let registrationAction: unknown;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-http-'));
    store = new Store(path.join(tmp, 'coagent.db'));
    cloudcli = new StubCloudCli();
    clock = Date.parse('2026-01-01T00:00:00Z');
    server = http.createServer(createHandler({
      broker: fakeBroker, store, cloudcli, token: 'mcp-token', dbFile: path.join(tmp, 'coagent.db'),
      registration: () => ({ claude: 'registered', codex: 'registered' }),
      register: async (action) => { registrationAction = action; return { claude: String(action), codex: String(action) }; },
      now: () => clock,
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function request(method: string, url: string, opts: { headers?: Record<string, string>; body?: string } = {}) {
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const headers = opts.body === undefined ? opts.headers : { 'content-type': 'application/json', ...opts.headers };
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  it('rejects oversized request bodies', async () => {
    const result = await request('POST', '/setup', { body: `{"apiKey":"${'x'.repeat(1024 * 1024)}"}` });
    expect(result.status).toBe(413);
  });

  it('rejects a non-loopback Host and browser Origin on MCP', async () => {
    expect((await request('GET', '/state', { headers: { host: 'evil.example' } })).status).toBe(400);
    const result = await request('POST', '/mcp/tool', {
      headers: { origin: 'https://evil.example', 'x-coagent-token': 'mcp-token', 'x-coagent-protocol': '1' }, body: '{}',
    });
    expect(result.status).toBe(403);
    expect((await request('GET', '/state', { headers: { origin: 'null' } })).status).toBe(403);
  });

  it('accepts a legacy missing protocol header and clearly rejects an explicit mismatch', async () => {
    expect((await request('POST', '/mcp/tool', { headers: { 'x-coagent-token': 'mcp-token' }, body: '{}' })).status).toBe(200);
    const result = await request('POST', '/mcp/tool', {
      headers: { 'x-coagent-token': 'mcp-token', 'x-coagent-protocol': '0' }, body: '{}',
    });
    expect(result.status).toBe(426);
    expect(result.body.error).toMatch(/protocol mismatch.*requires 1/i);
    expect(result.body.text).toMatch(/restart this session/i);
  });

  it('requires JSON for mutation routes and maps ToolError to its client status', async () => {
    expect((await request('POST', '/setup', { headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    const result = await request('POST', '/gates/3', {
      headers: { 'x-plugin-secret-apikey': 'tab-key' }, body: '{"approve":true}',
    });
    expect(result).toMatchObject({ status: 409, body: { error: 'Gate #3 is already approved.' } });
  });

  it('serves gate diffs only to an authorized tab and maps missing snapshots to 4xx', async () => {
    expect((await request('GET', '/gates/3/diff')).status).toBe(401);
    const headers = { 'x-plugin-secret-apikey': 'tab-key' };
    expect(await request('GET', '/gates/3/diff', { headers })).toMatchObject({
      status: 200, body: { gate: 3, diff: 'diff --git a/a b/a', truncated: false },
    });
    expect(await request('GET', '/gates/9/diff', { headers })).toMatchObject({
      status: 400, body: { error: 'Gate #9 has no code snapshot.' },
    });
  });

  it('preserves reliability worker message notes and the end-agent route', async () => {
    const headers = { 'x-plugin-secret-apikey': 'tab-key' };
    expect(await request('POST', '/agents/coder-1/messages', { headers, body: '{"body":"continue"}' }))
      .toMatchObject({ status: 200, body: { ok: true, note: 'Waiting for a worker slot.' } });
    expect(await request('POST', '/agents/coder-1/end', { headers, body: '{"removeWorktree":true}' }))
      .toMatchObject({ status: 200, body: { ok: true, text: 'Ended coder-1; remove=true.' } });
  });

  it('resume and cancel-resume are tab-authorized routes and map ToolErrors', async () => {
    expect((await request('POST', '/agents/coder-1/resume', { body: '{}' })).status).toBe(401);
    expect((await request('POST', '/agents/coder-1/cancel-resume', { body: '{}' })).status).toBe(401);
    expect((await request('POST', '/agents/coder-1/resume', { headers: { 'x-plugin-secret-apikey': 'wrong' }, body: '{}' })).status).toBe(401);
    const headers = { 'x-plugin-secret-apikey': 'tab-key' };
    expect(await request('POST', '/agents/coder-1/resume', { headers, body: '{}' }))
      .toMatchObject({ status: 200, body: { ok: true, text: 'Resumed coder-1 by user.' } });
    expect(await request('POST', '/agents/coder-1/cancel-resume', { headers, body: '{}' }))
      .toMatchObject({ status: 200, body: { ok: true, text: 'Cancelled the auto-resume of coder-1; the lead was told.' } });
    expect(await request('POST', '/agents/coder-busy/resume', { headers, body: '{}' }))
      .toMatchObject({ status: 409, body: { error: 'coder-busy is busy; try again when its turn is over.' } });
    expect((await request('GET', '/agents/coder-1/resume', { headers })).status).toBe(404);
  });

  it('keeps branch deletion tab-authorized and preserves lead-only ToolErrors', async () => {
    const url = '/runs/r-1/branches/delete-merged';
    expect((await request('POST', url, { body: '{"agentId":"lead"}' })).status).toBe(401);
    const headers = { 'x-plugin-secret-apikey': 'tab-key' };
    expect(await request('POST', url, { headers, body: '{"agentId":"worker"}' }))
      .toMatchObject({ status: 403, body: { error: 'Only the lead can delete run branches.' } });
    expect(await request('POST', url, { headers, body: '{"agentId":"lead"}' }))
      .toMatchObject({ status: 200, body: { deleted: [{ agentId: 'coder-1' }], skipped: [] } });
  });

  it('keeps workspace timeline events tab-authorized and validates their type', async () => {
    const url = '/runs/r-1/workspaces/event';
    expect((await request('POST', url, { body: '{"agentId":"coder-1","type":"workspace_archived","kind":"project"}' })).status).toBe(401);
    const headers = { 'x-plugin-secret-apikey': 'tab-key' };
    expect((await request('POST', url, { headers, body: '{"agentId":"coder-1","type":"other"}' })).status).toBe(400);
    expect((await request('POST', url, { headers, body: '{"agentId":"coder-1","type":"workspace_deleted","kind":"other"}' })).status).toBe(400);
    expect(await request('POST', url, { headers, body: '{"agentId":"coder-1","type":"workspace_deleted","kind":"project"}' }))
      .toMatchObject({ status: 200, body: { ok: true } });
  });

  it('keeps registration changes tab-authorized and reads the JSON action', async () => {
    expect((await request('POST', '/registration', { body: '{"action":"unregister"}' })).status).toBe(401);
    const result = await request('POST', '/registration', {
      headers: { 'x-plugin-secret-apikey': 'tab-key' }, body: '{"action":"unregister"}',
    });
    expect(result).toMatchObject({ status: 200, body: { claude: 'unregister', codex: 'unregister' } });
    expect(registrationAction).toBe('unregister');
    expect(store.getJson('autoRegister', true)).toBe(false);

    await request('POST', '/registration', {
      headers: { 'x-plugin-secret-apikey': 'tab-key' }, body: '{"action":"register"}',
    });
    expect(store.getJson('autoRegister', false)).toBe(true);
    expect((await request('POST', '/registration', {
      headers: { 'x-plugin-secret-apikey': 'tab-key' }, body: '{"action":"invalid"}',
    })).status).toBe(400);
  });

  it('the end-run route reports worktrees it could not delete', async () => {
    const headers = { 'x-plugin-secret-apikey': 'tab-key' };
    expect(await request('POST', '/runs/r-1/end', { headers, body: '{"removeWorktrees":true}' })).toMatchObject({
      status: 200, body: { ok: true, failedWorktrees: [{ agentId: 'coder-1', path: '/wt/r-1', reason: 'still running' }] },
    });
  });

  it('requires a fresh, unexpired, one-time setup nonce', async () => {
    const first = await request('GET', '/setup/nonce');
    const second = await request('GET', '/setup/nonce'); // must not replace the first
    expect((await request('POST', '/setup', { body: JSON.stringify({ apiKey: 'ck_wrong', nonce: 'not-a-real-nonce' }) })).status).toBe(403);
    expect((await request('POST', '/setup', { body: JSON.stringify({ apiKey: 'ck_valid', nonce: first.body.nonce }) })).status).toBe(200);
    expect((await request('POST', '/setup', { body: JSON.stringify({ apiKey: 'ck_reuse', nonce: first.body.nonce }) })).status).toBe(403);
    expect((await request('POST', '/setup', { body: JSON.stringify({ apiKey: 'ck_second', nonce: second.body.nonce }) })).status).toBe(200);

    const expiring = await request('GET', '/setup/nonce');
    clock += 5 * 60_000 + 1;
    expect((await request('POST', '/setup', { body: JSON.stringify({ apiKey: 'ck_expired', nonce: expiring.body.nonce }) })).status).toBe(403);
    expect(cloudcli.saved).toEqual(['ck_valid', 'ck_second']);
    expect(first.body).toHaveProperty('expiresAt');
  });

  it('returns the tab-authorized diagnostics shape', async () => {
    const result = await request('GET', '/diagnostics', { headers: { 'x-plugin-secret-apikey': 'tab-key' } });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      version: expect.any(String), protocol: 1, node: expect.stringMatching(/^v/),
      db: { path: path.join(tmp, 'coagent.db'), schema: { ok: true }, counts: { runs: {}, agents: {} }, undelivered: { total: 0 } },
      registration: { claude: 'registered', codex: 'registered' }, cloudcli: { ok: true, status: 200 },
    });
  });

  it('diagnoses a missing merge-snapshot schema column', async () => {
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.exec('ALTER TABLE gates DROP COLUMN unified_diff');
    const result = await request('GET', '/diagnostics', { headers: { 'x-plugin-secret-apikey': 'tab-key' } });
    expect(result.body).toMatchObject({ db: { schema: { ok: false, missingColumns: { gates: ['unified_diff'] } } } });
  });
});

describe('security utilities', () => {
  it('redacts credentials and body-like fields from JSON logs', () => {
    const lines: string[] = [];
    writeLog('error', 'request ck_ABC123 token=secret', { apiKey: 'ck_DEF456', prompt: 'do not log me', runId: 'r-1' }, (line) => lines.push(line));
    expect(lines[0]).not.toContain('ABC123');
    expect(lines[0]).not.toContain('DEF456');
    expect(lines[0]).not.toContain('do not log me');
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'error', runId: 'r-1', prompt: { redacted: true, length: 13 } });
    expect(redact('Bearer abcdef')).toBe('[REDACTED]');
    expect(redact({ 'x-coagent-token': 'abc', passwordHash: 'hash', comment: 'private' }))
      .toEqual({ 'x-coagent-token': '[REDACTED]', passwordHash: '[REDACTED]', comment: { redacted: true, length: 7 } });
    expect(redact('0123456789abcdef0123456789abcdef01234567')).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(redact('0123456789abcdef0123456789abcdef0123456789abcdef')).toBe('[REDACTED]');
    expect(redact(new Error('token=secret'))).toMatchObject({ message: '[REDACTED]', stack: expect.any(String) });
    expect(redact({ details: ['legacy prompt text'] })).toEqual({ details: { redacted: true, length: expect.any(Number) } });
  });

  it('tightens existing data and runtime permissions', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-mode-'));
    const runtime = path.join(tmp, 'runtime.json');
    fs.writeFileSync(runtime, '{}', { mode: 0o666 });
    fs.chmodSync(tmp, 0o755);
    secureDataPaths(tmp, runtime);
    expect(fs.statSync(tmp).mode & 0o777).toBe(0o700);
    expect(fs.statSync(runtime).mode & 0o777).toBe(0o600);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses symlinked security paths without chmodding their targets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-link-'));
    const target = path.join(tmp, 'target');
    const link = path.join(tmp, 'data');
    fs.mkdirSync(target, { mode: 0o755 });
    fs.symlinkSync(target, link);
    expect(() => secureDataPaths(link, path.join(link, 'runtime.json'))).toThrow(/symbolic link/);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);

    const realData = path.join(tmp, 'real-data');
    const runtimeLink = path.join(realData, 'runtime.json');
    const missingTarget = path.join(tmp, 'must-not-be-created');
    fs.mkdirSync(realData);
    fs.symlinkSync(missingTarget, runtimeLink);
    expect(() => secureDataPaths(realData, runtimeLink)).toThrow(/symbolic link/);
    expect(fs.existsSync(missingTarget)).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('formats startup failures as a CloudCLI readiness line', () => {
    expect(JSON.parse(startupFailureJson(new Error('owner mismatch')))).toEqual({ ready: false, error: 'owner mismatch' });
  });
});
