import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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
  userMessage: () => 'Waiting for a worker slot.',
  endAgent: async (id: string, removeWorktree: boolean) => `Ended ${id}; remove=${removeWorktree}.`,
} as unknown as Broker;

describe('broker HTTP hardening and diagnostics', () => {
  let tmp: string;
  let store: Store;
  let cloudcli: StubCloudCli;
  let server: http.Server;
  let port: number;
  let clock: number;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent-http-'));
    store = new Store(path.join(tmp, 'coagent.db'));
    cloudcli = new StubCloudCli();
    clock = Date.parse('2026-01-01T00:00:00Z');
    server = http.createServer(createHandler({
      broker: fakeBroker, store, cloudcli, token: 'mcp-token', dbFile: path.join(tmp, 'coagent.db'),
      registration: () => ({ claude: 'registered', codex: 'registered' }), register: async () => ({}), now: () => clock,
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

  it('preserves reliability worker message notes and the end-agent route', async () => {
    const headers = { 'x-plugin-secret-apikey': 'tab-key' };
    expect(await request('POST', '/agents/coder-1/messages', { headers, body: '{"body":"continue"}' }))
      .toMatchObject({ status: 200, body: { ok: true, note: 'Waiting for a worker slot.' } });
    expect(await request('POST', '/agents/coder-1/end', { headers, body: '{"removeWorktree":true}' }))
      .toMatchObject({ status: 200, body: { ok: true, text: 'Ended coder-1; remove=true.' } });
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
