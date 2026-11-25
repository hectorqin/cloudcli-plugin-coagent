import { describe, expect, it } from 'vitest';
import { codexBlock, removeCodexSection, upsertCodexToml } from '../src/broker/registration.js';
import { sseEvents } from '../src/broker/cloudcli.js';
import { callerFrom } from '../src/shim/mcp-shim.js';
import { pushActivity } from '../src/broker/broker.js';
import { VERSION } from '../src/shared/version.js';
import fs from 'node:fs';

describe('codex config.toml registration', () => {
  const block = codexBlock('/usr/bin/node', '/p/dist/mcp-shim.js');
  const existing = 'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n';

  it('appends, then is idempotent', () => {
    const once = upsertCodexToml(existing, block)!;
    expect(once).toContain('[mcp_servers.other]');
    expect(once).toContain('default_tools_approval_mode = "approve"');
    expect(upsertCodexToml(once, block)).toBeNull();
  });

  it('replaces a stale block without touching neighbours', () => {
    const stale = `${existing}\n[mcp_servers.coagent]\ncommand = "old"\nargs = ["old.js"]\n\n[profiles.x]\nmodel = "y"\n`;
    const next = upsertCodexToml(stale, block)!;
    expect(next).not.toContain('old.js');
    expect(next).toContain('[profiles.x]\nmodel = "y"');
    expect(next.match(/\[mcp_servers\.coagent\]/g)).toHaveLength(1);
  });

  it('removes only our section', () => {
    const next = removeCodexSection(upsertCodexToml(existing, block)!)!;
    expect(next).not.toContain('coagent');
    expect(next).toContain('[mcp_servers.other]');
    expect(removeCodexSection(existing)).toBeNull();
  });
});

describe('shim caller identity', () => {
  it('uses the Codex turn metadata thread id', () => {
    const meta = { 'x-codex-turn-metadata': { thread_id: 't-1', session_id: 't-1' }, threadId: 't-1' };
    expect(callerFrom({}, meta, '/w')).toEqual({ provider: 'codex', providerSessionId: 't-1', cwd: '/w' });
  });
  it('prefers Codex metadata over a leaked Claude env var', () => {
    const meta = { 'x-codex-turn-metadata': { thread_id: 't-2' } };
    expect(callerFrom({ CLAUDE_CODE_SESSION_ID: 'c' }, meta, '/w').provider).toBe('codex');
  });
  it('uses CLAUDE_CODE_SESSION_ID for Claude', () => {
    expect(callerFrom({ CLAUDE_CODE_SESSION_ID: 'c-1', CLAUDE_PROJECT_DIR: '/proj' }, undefined, '/w'))
      .toEqual({ provider: 'claude', providerSessionId: 'c-1', cwd: '/proj' });
  });
  it('reports unknown identity otherwise', () => {
    expect(callerFrom({}, {}, '/w').providerSessionId).toBeNull();
  });
});

describe('SSE parsing', () => {
  it('yields JSON data events across chunk boundaries', async () => {
    const enc = new TextEncoder();
    const parts = ['data: {"type":"session-id","sessionId":"a"}\n', '\ndata: {"kind":"text"}\n\ndata: {"ty', 'pe":"done"}\n\n'];
    const body = new ReadableStream<Uint8Array>({ start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close(); } });
    const out = [];
    for await (const e of sseEvents(body)) out.push(e);
    expect(out).toEqual([{ type: 'session-id', sessionId: 'a' }, { kind: 'text' }, { type: 'done' }]);
  });
});

describe('activity capture', () => {
  it('updates a progressing tool call in place and drops consecutive repeats', () => {
    let list = pushActivity([], { toolId: 't1' }, 'Bash: ls', 'a');
    list = pushActivity(list, { toolId: 't1' }, 'Bash: ls (done)', 'b');
    list = pushActivity(list, {}, 'thinking', 'c');
    list = pushActivity(list, {}, 'thinking', 'd');
    expect(list.map((x) => x.text)).toEqual(['Bash: ls (done)', 'thinking']);
  });
});

describe('version', () => {
  it('is the same in package.json, manifest.json and the code', () => {
    for (const f of ['package.json', 'manifest.json']) expect(JSON.parse(fs.readFileSync(f, 'utf8')).version).toBe(VERSION);
  });
});
