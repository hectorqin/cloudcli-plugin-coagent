import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Provider } from '../shared/protocol.js';
import { PLUGIN_NAME } from './paths.js';

export interface SessionInfo {
  appSessionId: string;
  providerSessionId: string | null;
  provider: string;
  projectPath: string;
}

export interface SendInput {
  projectPath: string;
  provider: Provider;
  /** App or provider session id; omit to start a new session. */
  sessionId?: string | null;
  message: string;
}

export type SendResult =
  | { status: 'ok'; appSessionId: string | null }
  | { status: 'busy' }
  | { status: 'error'; error: string };

/** Everything the broker needs from CloudCLI. Faked in tests. */
export interface CloudCli {
  apiKeyConfigured(): boolean;
  /** True when `candidate` equals the configured API key (used to authenticate tab requests proxied by CloudCLI). */
  verifyApiKey(candidate: string): boolean;
  /** Checks a key against CloudCLI and stores it as the plugin secret. CloudCLI has no UI for plugin secrets. */
  saveApiKey(candidate: string): Promise<void>;
  /** Starts or continues a run via POST /api/agent and resolves when the run finishes. */
  send(input: SendInput, onAppSessionId?: (id: string) => void, onEvent?: (event: Record<string, unknown>) => void): Promise<SendResult>;
  sessionByProviderId(providerSessionId: string): SessionInfo | null;
  sessionByAppId(appSessionId: string): SessionInfo | null;
}

const HOME = os.homedir();

export class HttpCloudCli implements CloudCli {
  constructor(
    private opts: {
      dbPath?: string;
      pluginsConfigPath?: string;
      localServerPath?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  private get dbPath() { return this.opts.dbPath ?? path.join(HOME, '.cloudcli', 'auth.db'); }

  private baseUrl(): string {
    try {
      const f = this.opts.localServerPath ?? path.join(HOME, '.cloudcli', 'local-server.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { host?: string; port?: number };
      if (j.port) return `http://${j.host && j.host !== '0.0.0.0' ? j.host : '127.0.0.1'}:${j.port}`;
    } catch { /* fall through */ }
    return process.env.COAGENT_CLOUDCLI_URL ?? 'http://127.0.0.1:3001';
  }

  /** The API key lives in CloudCLI's plugin secrets; read it fresh each time so edits in Settings apply immediately. */
  private apiKey(): string | null {
    if (process.env.COAGENT_API_KEY) return process.env.COAGENT_API_KEY;
    try {
      const f = this.pluginsConfigPath;
      const secrets = (JSON.parse(fs.readFileSync(f, 'utf8'))[PLUGIN_NAME]?.secrets ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(secrets)) {
        if (/^(api[_-]?key|cloudcli[_-]?api[_-]?key)$/i.test(k) && typeof v === 'string' && v) return v;
      }
    } catch { /* not configured */ }
    return null;
  }

  apiKeyConfigured() { return this.apiKey() !== null; }

  verifyApiKey(candidate: string) {
    const key = this.apiKey();
    if (!key || !candidate) return false;
    const a = Buffer.from(key);
    const b = Buffer.from(candidate);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private get pluginsConfigPath() {
    return this.opts.pluginsConfigPath ?? path.join(HOME, '.claude-code-ui', 'plugins.json');
  }

  async saveApiKey(candidate: string) {
    const key = candidate.trim();
    if (!/^ck_[A-Za-z0-9]+$/.test(key)) throw new Error('That does not look like a CloudCLI API key (ck_…).');
    // An empty body passes auth first: 401/403 means a bad key, 400 means the key was accepted.
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.baseUrl()}/api/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: '{}',
    });
    if (res.status === 401 || res.status === 403) throw new Error('CloudCLI rejected this API key.');
    const file = this.pluginsConfigPath;
    const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    cfg[PLUGIN_NAME] = { ...cfg[PLUGIN_NAME], secrets: { ...cfg[PLUGIN_NAME]?.secrets, apiKey: key } };
    const tmp = `${file}.coagent.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  async send(input: SendInput, onAppSessionId?: (id: string) => void, onEvent?: (event: Record<string, unknown>) => void): Promise<SendResult> {
    const key = this.apiKey();
    if (!key) return { status: 'error', error: 'CloudCLI API key is not configured (plugin secret "apiKey")' };
    const doFetch = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.baseUrl()}/api/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          projectPath: input.projectPath,
          provider: input.provider,
          message: input.message,
          stream: true,
          // Let MCP elicitation forms (inline approvals) show in the session's tab instead of being auto-declined.
          unattended: false,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        }),
      });
    } catch (e) {
      return { status: 'error', error: `CloudCLI unreachable: ${(e as Error).message}` };
    }
    if (res.status === 409) return { status: 'busy' };
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      return { status: 'error', error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }

    let appSessionId: string | null = null;
    let error: string | null = null;
    for await (const event of sseEvents(res.body)) {
      if (event.type === 'session-id' && typeof event.sessionId === 'string') {
        appSessionId = event.sessionId;
        onAppSessionId?.(appSessionId);
      } else if (event.type === 'error' || event.kind === 'error') {
        error = String(event.error ?? event.message ?? event.content ?? 'unknown error');
      } else {
        onEvent?.(event);
      }
    }
    return error ? { status: 'error', error } : { status: 'ok', appSessionId };
  }

  private query(sql: string, ...params: string[]): SessionInfo | null {
    if (!fs.existsSync(this.dbPath)) return null;
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      const r = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
      return r
        ? {
          appSessionId: String(r.session_id),
          providerSessionId: r.provider_session_id ? String(r.provider_session_id) : null,
          provider: String(r.provider),
          projectPath: String(r.project_path ?? ''),
        }
        : null;
    } finally {
      db.close();
    }
  }

  sessionByProviderId(providerSessionId: string): SessionInfo | null {
    return this.query('SELECT * FROM sessions WHERE provider_session_id = ?', providerSessionId)
      // A provider id can be replaced (e.g. on resume); the old one still maps to the same app session.
      ?? this.query(`SELECT s.* FROM superseded_provider_sessions x JOIN sessions s ON s.session_id = x.session_id
        WHERE x.provider_session_id = ?`, providerSessionId);
  }

  sessionByAppId(appSessionId: string): SessionInfo | null {
    return this.query('SELECT * FROM sessions WHERE session_id = ?', appSessionId);
  }
}

/** Minimal SSE parser over a fetch body: yields each `data:` JSON payload. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { yield JSON.parse(data) as Record<string, unknown>; } catch { /* ignore non-JSON */ }
    }
  }
}
