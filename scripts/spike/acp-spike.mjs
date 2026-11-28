#!/usr/bin/env node
// Spike: drive `agy acp` over ACP v1 and answer the five design questions in docs (Antigravity plan, Q4):
//   1. does session/new honor mcpServers (stdio and HTTP), and which headers/env reach the MCP server?
//   2. session/resume (and session/load) on a fresh process
//   3. the shape of session/request_permission
//   4. the shape of errors (quota/limit) — read off whatever error the run produces
//   5. whether usage/token updates are reported
// Single session at a time, by design (Google asks for one agy task at a time on cloud servers).
//
// Usage: node scripts/spike/acp-spike.mjs [--agy <path>] [--cwd <dir>] [--log <file>] [--mode default|auto_edit|yolo]
// Every JSON-RPC frame both ways goes to the log as NDJSON; a summary prints at the end.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const AGY = args.agy ?? path.join(os.homedir(), '.local/bin/agy');
const CWD = path.resolve(args.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'acp-spike-ws-')));
const LOG = path.resolve(args.log ?? path.join(CWD, 'acp-spike.ndjson'));
const MODE = args.mode ?? 'default';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_STDIO = 'stdio-' + Math.random().toString(36).slice(2);
const TOKEN_HTTP = 'http-' + Math.random().toString(36).slice(2);

const log = (dir, obj) => fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), dir, ...obj }) + '\n');
const findings = { mcpCalls: [], permissionRequests: [], errors: [], usage: [], updateKinds: new Set() };

// ---- HTTP MCP probe (streamable HTTP, JSON responses only) ----
const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const headers = { authorization: req.headers.authorization, 'x-coagent-token': req.headers['x-coagent-token'] };
    log('mcp-http<', { method: req.method, headers, body });
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    const reply = mcpHandle(msg, { transport: 'http', headers });
    if (!reply) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'spike' }).end(JSON.stringify(reply));
  });
});

function mcpHandle(msg, ctx) {
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spike-http', version: '0' } } };
  }
  if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'whoami_http', description: 'Returns a secret word. Call it when asked for the HTTP secret.', inputSchema: { type: 'object', properties: {} } }] } };
  }
  if (msg.method === 'tools/call') {
    findings.mcpCalls.push({ ...ctx, tool: msg.params?.name, meta: msg.params?._meta ?? null });
    return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'PINEAPPLE' }] } };
  }
  return msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, result: {} };
}

// ---- ACP client ----
let agent, nextId = 1;
const pending = new Map();
function startAgent() {
  agent = spawn(AGY, ['acp'], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  agent.stderr.on('data', (d) => log('stderr', { text: String(d) }));
  agent.on('exit', (code, sig) => log('exit', { code, sig }));
  readline.createInterface({ input: agent.stdout }).on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { log('agent-raw', { line }); return; }
    log('<', msg);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) findings.errors.push(msg.error);
      resolve(msg);
    } else if (msg.method) onAgentRequest(msg);
  });
}
const send = (obj) => { log('>', obj); agent.stdin.write(JSON.stringify(obj) + '\n'); };
const call = (method, params, timeoutMs = 300_000) => new Promise((resolve) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); resolve({ id, error: { message: `timeout ${method}` } }); }, timeoutMs);
  pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
  send({ jsonrpc: '2.0', id, method, params });
});

function onAgentRequest(msg) {
  const { method, params, id } = msg;
  if (method === 'session/update') {
    const u = params?.update ?? {};
    findings.updateKinds.add(u.sessionUpdate);
    if (/usage/i.test(u.sessionUpdate ?? '') || u.usage || params?._meta?.usage) findings.usage.push(u);
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) process.stdout.write(u.content.text);
    return;
  }
  if (method === 'session/request_permission') {
    findings.permissionRequests.push(params);
    const allow = params?.options?.find((o) => o.kind === 'allow_once') ?? params?.options?.[0];
    send({ jsonrpc: '2.0', id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } });
    return;
  }
  if (method === 'fs/read_text_file') {
    const p = path.resolve(CWD, params.path);
    if (!p.startsWith(CWD)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'outside workspace' } });
    try { return send({ jsonrpc: '2.0', id, result: { content: fs.readFileSync(p, 'utf8') } }); } catch (e) { return send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e) } }); }
  }
  if (method === 'fs/write_text_file') {
    const p = path.resolve(CWD, params.path);
    if (!p.startsWith(CWD)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'outside workspace' } });
    fs.writeFileSync(p, params.content); return send({ jsonrpc: '2.0', id, result: null });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `spike client does not implement ${method}` } });
}

function mcpServers(port, caps) {
  const list = [{
    name: 'spike-stdio', command: process.execPath, args: [path.join(HERE, 'mcp-stdio-probe.mjs'), LOG],
    env: [{ name: 'COAGENT_TOKEN', value: TOKEN_STDIO }],
  }];
  if (caps?.mcpCapabilities?.http) {
    list.push({ type: 'http', name: 'spike-http', url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${TOKEN_HTTP}` }] });
  }
  return list;
}

async function main() {
  fs.writeFileSync(path.join(CWD, 'notes.txt'), 'hello\n');
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  console.log(`workspace ${CWD}\nlog ${LOG}`);

  startAgent();
  const init = await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: 'coagent-spike', version: '0' } }, 60_000);
  const caps = init.result?.agentCapabilities;
  console.log('\n[initialize]', JSON.stringify(init.result ?? init.error, null, 2));

  const servers = mcpServers(port, caps);
  const created = await call('session/new', { cwd: CWD, mcpServers: servers }, 120_000);
  const sessionId = created.result?.sessionId;
  console.log('\n[session/new]', JSON.stringify(created.result ?? created.error, null, 2));
  if (!sessionId) return finish();

  if (MODE !== 'default') await call('session/set_mode', { sessionId, modeId: MODE }, 30_000);

  const prompt = (text) => call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 600_000);
  let r = await prompt('Call the whoami tool from the spike-stdio MCP server and, if available, whoami_http from spike-http. Reply with the secret words they return, nothing else.');
  console.log('\n[prompt 1 stopReason]', JSON.stringify(r.result ?? r.error));
  r = await prompt('Append the line "spike was here" to notes.txt in the workspace, then run the shell command `cat notes.txt`.');
  console.log('\n[prompt 2 stopReason]', JSON.stringify(r.result ?? r.error));

  // Continuation on a fresh process, the way a broker restart or a quota pause would need it.
  agent.stdin.end(); agent.kill();
  await new Promise((res) => setTimeout(res, 1500));
  startAgent();
  const init2 = await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } }, 60_000);
  const sc = init2.result?.agentCapabilities ?? {};
  const resumeMethod = sc.sessionCapabilities?.resume ? 'session/resume' : sc.loadSession ? 'session/load' : 'session/resume';
  const resumed = await call(resumeMethod, { sessionId, cwd: CWD, mcpServers: servers }, 120_000);
  console.log(`\n[${resumeMethod}]`, JSON.stringify(resumed.result ?? resumed.error));
  if (!resumed.error) {
    r = await prompt('What was the secret word from the stdio tool earlier in this conversation? One word.');
    console.log('\n[prompt 3 stopReason]', JSON.stringify(r.result ?? r.error));
  }
  finish();
}

function finish() {
  const stdioCalls = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('"dir":"mcp-stdio-call"')).map((l) => JSON.parse(l));
  console.log('\n===== SUMMARY =====');
  console.log(JSON.stringify({
    stdioMcpCalls: stdioCalls.map((c) => ({ tool: c.tool, tokenSeen: c.token === TOKEN_STDIO, meta: c.meta })),
    httpMcpCalls: findings.mcpCalls.map((c) => ({ tool: c.tool, tokenSeen: c.headers.authorization === `Bearer ${TOKEN_HTTP}`, meta: c.meta })),
    permissionRequests: findings.permissionRequests,
    errors: findings.errors,
    usageUpdates: findings.usage,
    sessionUpdateKinds: [...findings.updateKinds],
  }, null, 2));
  try { agent?.kill(); } catch { /* gone */ }
  httpServer.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); finish(); });
