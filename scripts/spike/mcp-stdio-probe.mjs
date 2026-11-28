#!/usr/bin/env node
// Minimal stdio MCP server for the ACP spike: one tool, logs every call plus the env token it was started with.
import fs from 'node:fs';
import readline from 'node:readline';

const LOG = process.argv[2];
const log = (obj) => LOG && fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
log({ dir: 'mcp-stdio-start', token: process.env.COAGENT_TOKEN ?? null, envKeys: Object.keys(process.env).filter((k) => /AGY|GEMINI|ANTIGRAVITY|SESSION|COAGENT/i.test(k)) });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  log({ dir: 'mcp-stdio<', msg });
  if (msg.method === 'initialize') {
    out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spike-stdio', version: '0' } } });
  } else if (msg.method === 'tools/list') {
    out({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'whoami', description: 'Returns a secret word. Call it when asked for the secret.', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (msg.method === 'tools/call') {
    log({ dir: 'mcp-stdio-call', tool: msg.params?.name, token: process.env.COAGENT_TOKEN ?? null, meta: msg.params?._meta ?? null });
    out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'BANANA' }] } });
  } else if (msg.id !== undefined) {
    out({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
