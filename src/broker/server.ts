/**
 * CoAgent broker: spawned by CloudCLI as the plugin server (`node dist/server.js`).
 * Serves two audiences on one loopback port:
 *  - the MCP shim (`/mcp/tool`), authenticated with a per-start token from runtime.json;
 *  - the tab UI via CloudCLI's RPC proxy, authenticated by the API-key plugin secret the proxy injects.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolRequest } from '../shared/protocol.js';
import { Broker } from './broker.js';
import { HttpCloudCli } from './cloudcli.js';
import { Git } from './git.js';
import { DATA_DIR, DB_FILE, RUNTIME_FILE } from './paths.js';
import { filePrompts } from './prompts.js';
import { ensureRegistered, unregister } from './registration.js';
import { Store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const shimPath = path.join(pluginRoot, 'dist', 'mcp-shim.js');
const log = (...a: unknown[]) => console.error('[coagent]', ...a);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const store = new Store(DB_FILE);
const cloudcli = new HttpCloudCli();
let registration: Record<string, string> = {};
const broker = new Broker({
  store, cloudcli, git: Git, prompts: filePrompts(path.join(pluginRoot, 'prompts')), log,
  setupInfo: () => registration,
});
// Before serving: settle what a previous process left mid-flight (orphaned dispatches, workers cut off mid-turn).
// Requests wait for it, so no tool call or delivery pass sees half-recovered state.
const recovered: Promise<void> = broker.recover().then(
  (r) => { if (r.interrupted.length || r.detached.length || r.requeued.length) log('startup recovery', r); },
  (e) => log('startup recovery failed', e),
);
const token = crypto.randomBytes(24).toString('hex');

class HttpError extends Error { constructor(public code: number, msg: string) { super(msg); } }

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function tabAuthorized(req: http.IncomingMessage): boolean {
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith('x-plugin-secret-') && typeof v === 'string' && cloudcli.verifyApiKey(v)) return true;
  }
  return false;
}

function config() {
  return { roleProviders: broker.roleProviders(), autoRegister: store.getJson('autoRegister', true) };
}

async function route(req: http.IncomingMessage, url: URL): Promise<unknown> {
  await recovered;
  const m = req.method ?? 'GET';
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/mcp/tool' && m === 'POST') {
    if (req.headers['x-coagent-token'] !== token) throw new HttpError(401, 'bad token');
    return broker.handleTool((await readJson(req)) as unknown as ToolRequest);
  }

  // Without an API key nothing works yet; the tab still needs to render setup instructions.
  if (!tabAuthorized(req)) {
    if (!cloudcli.apiKeyConfigured()) {
      if (p === '/state' && m === 'GET') return { setup: { apiKeyConfigured: false, registration }, me: null, current: null, runs: [] };
      // First-run setup only: once a key exists, changing it requires the current key (i.e. an authorized request).
      if (p === '/setup' && m === 'POST') { await cloudcli.saveApiKey(String((await readJson(req)).apiKey ?? '')); return { ok: true }; }
    }
    throw new HttpError(401, 'set the plugin secret "apiKey" to a CloudCLI API key');
  }

  if (p === '/setup' && m === 'POST') { await cloudcli.saveApiKey(String((await readJson(req)).apiKey ?? '')); return { ok: true }; }
  if (p === '/state' && m === 'GET') return broker.state(url.searchParams.get('session'), url.searchParams.get('run'));
  if (p === '/config' && m === 'GET') return config();
  if (p === '/config' && m === 'PUT') {
    const b = await readJson(req);
    if (b.roleProviders && typeof b.roleProviders === 'object') broker.setRoleProviders(b.roleProviders as Record<string, string>);
    if (typeof b.autoRegister === 'boolean') store.setJson('autoRegister', b.autoRegister);
    return config();
  }
  if (p === '/registration' && m === 'POST') {
    const b = await readJson(req);
    registration = b.action === 'unregister' ? await unregister() : await ensureRegistered(shimPath);
    return registration;
  }
  let mm: RegExpMatchArray | null;
  if ((mm = p.match(/^\/gates\/(\d+)$/)) && m === 'POST') {
    const b = await readJson(req);
    return broker.decideGate(Number(mm[1]), b.approve === true, typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : null);
  }
  if ((mm = p.match(/^\/agents\/([\w-]+)\/messages$/)) && m === 'POST') {
    const b = await readJson(req);
    const note = broker.userMessage(mm[1], String(b.body ?? ''));
    return { ok: true, ...(note ? { note } : {}) };
  }
  if ((mm = p.match(/^\/agents\/([\w-]+)\/end$/)) && m === 'POST') {
    const b = await readJson(req);
    return { ok: true, text: await broker.endAgent(mm[1], b.removeWorktree === true, null) };
  }
  if ((mm = p.match(/^\/runs\/([\w-]+)\/end$/)) && m === 'POST') {
    const b = await readJson(req);
    await broker.endRun(mm[1], b.removeWorktrees === true);
    return { ok: true };
  }
  throw new HttpError(404, 'not found');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  try {
    const out = await route(req, new URL(req.url ?? '/', 'http://localhost'));
    res.end(JSON.stringify(out));
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 400;
    if (code >= 500 || !(e instanceof HttpError)) log(req.method, req.url, e);
    res.writeHead(code);
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ port: addr.port, token, pid: process.pid }), { mode: 0o600 });
  // Required by CloudCLI: the first stdout JSON line announces readiness.
  console.log(JSON.stringify({ ready: true, port: addr.port }));
  log(`listening on ${addr.port}`);

  if (config().autoRegister) {
    ensureRegistered(shimPath).then((r) => { registration = r; log('mcp registration', r); }, (e) => log('registration failed', e));
  } else {
    registration = { claude: 'auto-register disabled', codex: 'auto-register disabled' };
  }
  void recovered.then(() => setInterval(() => { void broker.tick(); }, 3000).unref());
});

function shutdown() {
  try {
    const rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (rt.pid === process.pid) fs.rmSync(RUNTIME_FILE);
  } catch { /* already gone */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
