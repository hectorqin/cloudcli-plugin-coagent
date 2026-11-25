/** Loopback HTTP broker for the MCP shim and CloudCLI-proxied tab. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolRequest } from '../shared/protocol.js';
import { PROTOCOL_VERSION, VERSION } from '../shared/version.js';
import { Broker } from './broker.js';
import { HttpCloudCli } from './cloudcli.js';
import { Git } from './git.js';
import { brokerLog, writeLog } from './log.js';
import { DATA_DIR, DB_FILE, RUNTIME_FILE } from './paths.js';
import { filePrompts } from './prompts.js';
import { ensureRegistered, unregister } from './registration.js';
import { Store } from './store.js';

const MAX_BODY = 1024 * 1024;
const NONCE_TTL = 5 * 60_000;

export class HttpError extends Error { constructor(public code: number, msg: string) { super(msg); } }

function assertOwned(file: string) {
  if (!fs.existsSync(file) || process.getuid === undefined) return;
  const uid = process.getuid();
  const actual = fs.statSync(file).uid;
  if (actual !== uid) throw new Error(`refusing to start: ${file} is owned by uid ${actual}, expected uid ${uid}`);
}

export function secureDataPaths(dataDir = DATA_DIR, runtimeFile = RUNTIME_FILE) {
  if (fs.existsSync(dataDir)) assertOwned(dataDir);
  else fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  if (fs.existsSync(runtimeFile)) {
    assertOwned(runtimeFile);
    fs.chmodSync(runtimeFile, 0o600);
  }
}

export async function readJson(req: http.IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`);
    chunks.push(b);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function validHost(req: http.IncomingMessage) {
  const port = req.socket.localPort;
  return !!port && (req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`);
}

export interface HandlerDeps {
  broker: Broker;
  store: Store;
  cloudcli: HttpCloudCli;
  token: string;
  dbFile: string;
  registration: () => Record<string, string>;
  register: (action: unknown) => Promise<Record<string, string>>;
  now?: () => number;
}

export function createHandler(d: HandlerDeps): http.RequestListener {
  let nonce: { value: string; expires: number } | null = null;
  const now = d.now ?? Date.now;
  const tabAuthorized = (req: http.IncomingMessage) => Object.entries(req.headers).some(
    ([k, v]) => k.startsWith('x-plugin-secret-') && typeof v === 'string' && d.cloudcli.verifyApiKey(v),
  );
  const config = () => ({ roleProviders: d.broker.roleProviders(), autoRegister: d.store.getJson('autoRegister', true) });

  async function route(req: http.IncomingMessage, url: URL): Promise<unknown> {
    const method = req.method ?? 'GET';
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (!validHost(req)) throw new HttpError(400, 'invalid Host header: expected 127.0.0.1 or localhost on the listening port');
    if (p.startsWith('/mcp/') && req.headers.origin !== undefined) throw new HttpError(403, 'browser-originated MCP requests are not allowed');
    if (p === '/mcp/tool' && method === 'POST') {
      if (req.headers['x-coagent-protocol'] !== String(PROTOCOL_VERSION)) throw new HttpError(426, `CoAgent protocol mismatch: broker requires ${PROTOCOL_VERSION}`);
      if (req.headers['x-coagent-token'] !== d.token) throw new HttpError(401, 'bad token');
      return d.broker.handleTool((await readJson(req)) as unknown as ToolRequest);
    }

    const authorized = tabAuthorized(req);
    if (!authorized && !d.cloudcli.apiKeyConfigured()) {
      if (p === '/state' && method === 'GET') return { setup: { apiKeyConfigured: false, registration: d.registration() }, me: null, current: null, runs: [] };
      if (p === '/setup/nonce' && method === 'GET') {
        nonce = { value: crypto.randomBytes(18).toString('base64url'), expires: now() + NONCE_TTL };
        return { nonce: nonce.value, expiresAt: new Date(nonce.expires).toISOString() };
      }
      if (p === '/setup' && method === 'POST') {
        const body = await readJson(req);
        const supplied = typeof body.nonce === 'string' ? body.nonce : '';
        const suppliedBytes = Buffer.from(supplied);
        const expectedBytes = Buffer.from(nonce?.value ?? '');
        const valid = !!nonce && nonce.expires > now() && suppliedBytes.length === expectedBytes.length
          && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
        // Protects against stray local web pages/processes, not another process running as the same Unix user.
        nonce = null;
        if (!valid) throw new HttpError(403, 'missing, expired, or already-used setup nonce');
        await d.cloudcli.saveApiKey(String(body.apiKey ?? ''));
        return { ok: true };
      }
    }
    if (!authorized) throw new HttpError(401, 'set the plugin secret "apiKey" to a CloudCLI API key');

    if (p === '/setup' && method === 'POST') { await d.cloudcli.saveApiKey(String((await readJson(req)).apiKey ?? '')); return { ok: true }; }
    if (p === '/state' && method === 'GET') return d.broker.state(url.searchParams.get('session'), url.searchParams.get('run'));
    if (p === '/diagnostics' && method === 'GET') return {
      version: VERSION, protocol: PROTOCOL_VERSION, node: process.version,
      db: { path: d.dbFile, ...d.store.diagnostics(now()) }, registration: d.registration(),
      cloudcli: await d.cloudcli.health(2000),
    };
    if (p === '/config' && method === 'GET') return config();
    if (p === '/config' && method === 'PUT') {
      const body = await readJson(req);
      if (body.roleProviders && typeof body.roleProviders === 'object') d.broker.setRoleProviders(body.roleProviders as Record<string, string>);
      if (typeof body.autoRegister === 'boolean') d.store.setJson('autoRegister', body.autoRegister);
      return config();
    }
    if (p === '/registration' && method === 'POST') return d.register((await readJson(req)).action);
    let match: RegExpMatchArray | null;
    if ((match = p.match(/^\/gates\/(\d+)\/diff$/)) && method === 'GET') return d.broker.gateDiff(Number(match[1]));
    if ((match = p.match(/^\/gates\/(\d+)$/)) && method === 'POST') {
      const body = await readJson(req);
      return d.broker.decideGate(Number(match[1]), body.approve === true, typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim() : null);
    }
    if ((match = p.match(/^\/agents\/([\w-]+)\/messages$/)) && method === 'POST') {
      const body = await readJson(req);
      const note = d.broker.userMessage(match[1], String(body.body ?? ''));
      return { ok: true, ...(note ? { note } : {}) };
    }
    if ((match = p.match(/^\/agents\/([\w-]+)\/end$/)) && method === 'POST') {
      const body = await readJson(req);
      return { ok: true, text: await d.broker.endAgent(match[1], body.removeWorktree === true, null) };
    }
    if ((match = p.match(/^\/runs\/([\w-]+)\/end$/)) && method === 'POST') {
      const body = await readJson(req); await d.broker.endRun(match[1], body.removeWorktrees === true); return { ok: true };
    }
    throw new HttpError(404, 'not found');
  }

  return async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try { res.end(JSON.stringify(await route(req, new URL(req.url ?? '/', 'http://localhost')))); }
    catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      if (code >= 500) writeLog('error', 'HTTP request failed', { method: req.method, path: req.url, error: e });
      res.writeHead(code); res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'internal error' }));
    }
  };
}

export async function start() {
  secureDataPaths();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(here, '..');
  const shimPath = path.join(pluginRoot, 'dist', 'mcp-shim.js');
  const store = new Store(DB_FILE);
  const cloudcli = new HttpCloudCli();
  let registration: Record<string, string> = {};
  const broker = new Broker({ store, cloudcli, git: Git, prompts: filePrompts(path.join(pluginRoot, 'prompts')), log: brokerLog, setupInfo: () => registration });
  // Recovery completes before the port opens, so no request or timer can observe half-recovered state.
  await broker.recover().then((r) => {
    if (r.interrupted.length || r.detached.length || r.requeued.length) {
      writeLog('info', 'startup recovery', { interrupted: r.interrupted, detached: r.detached, requeued: r.requeued });
    }
  }, (e) => writeLog('error', 'startup recovery failed', { error: e }));
  const token = crypto.randomBytes(24).toString('hex');
  const instance = crypto.randomUUID();
  const server = http.createServer(createHandler({
    broker, store, cloudcli, token, dbFile: DB_FILE, registration: () => registration,
    register: async (action) => (registration = action === 'unregister' ? await unregister() : await ensureRegistered(shimPath)),
  }));
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ port: addr.port, token, pid: process.pid, instance, protocol: PROTOCOL_VERSION }), { mode: 0o600 });
    fs.chmodSync(RUNTIME_FILE, 0o600);
    console.log(JSON.stringify({ ready: true, port: addr.port }));
    writeLog('info', 'broker listening', { port: addr.port, instance });
    if (store.getJson('autoRegister', true)) {
      ensureRegistered(shimPath).then((r) => { registration = r; writeLog('info', 'MCP registration complete', { registration: r }); },
        (e) => writeLog('error', 'MCP registration failed', { error: e }));
    } else registration = { claude: 'auto-register disabled', codex: 'auto-register disabled' };
    setInterval(() => { void broker.tick(); }, 3000).unref();
  });
  const shutdown = () => {
    try {
      const rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as { pid?: number; instance?: string };
      if (rt.pid === process.pid && rt.instance === instance) fs.rmSync(RUNTIME_FILE);
    } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return server;
}

if (!process.env.VITEST) {
  void start().catch((e) => { writeLog('error', 'CoAgent broker refused to start', { error: e }); process.exitCode = 1; });
}
