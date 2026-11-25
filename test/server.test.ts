import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../src/broker/broker.js';
import { HttpCloudCli } from '../src/broker/cloudcli.js';
import { redact, writeLog } from '../src/broker/log.js';
import { createHandler, secureDataPaths } from '../src/broker/server.js';
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
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: opts.headers }, (res) => {
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
  });

  it('returns a clear MCP protocol mismatch', async () => {
    const result = await request('POST', '/mcp/tool', {
      headers: { 'x-coagent-token': 'mcp-token', 'x-coagent-protocol': '0' }, body: '{}',
    });
    expect(result.status).toBe(426);
    expect(result.body.error).toMatch(/protocol mismatch.*requires 1/i);
  });

  it('requires a fresh, unexpired, one-time setup nonce', async () => {
    const first = await request('GET', '/setup/nonce');
    expect((await request('POST', '/setup', { body: JSON.stringify({ apiKey: 'ck_first' }) })).status).toBe(403);

    const expiring = await request('GET', '/setup/nonce');
    clock += 5 * 60_000 + 1;
    expect((await request('POST', '/setup', { body: JSON.stringify({ apiKey: 'ck_expired', nonce: expiring.body.nonce }) })).status).toBe(403);

    const valid = await request('GET', '/setup/nonce');
    expect((await request('POST', '/setup', { body: JSON.stringify({ apiKey: 'ck_valid', nonce: valid.body.nonce }) })).status).toBe(200);
    expect(cloudcli.saved).toEqual(['ck_valid']);
    expect((await request('POST', '/setup', { body: JSON.stringify({ apiKey: 'ck_reuse', nonce: valid.body.nonce }) })).status).toBe(403);
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
});
