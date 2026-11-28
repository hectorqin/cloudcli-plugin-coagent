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
  /**
   * Nests a NEW session under this parent (app or provider session id) in CloudCLI's sidebar. Only for a run that
   * creates its session (no `sessionId`), and only when `capabilities().childSessions` is true: hosts without child
   * sessions are not relied on to ignore the field, and a host that has them rejects a changed parent on continuation.
   */
  parentSessionId?: string | null;
}

/** Optional Agent API features (GET /api/agent/capabilities). null = unknown: no key, or the query failed / timed out. */
export interface Capabilities {
  sessionStatus: boolean | null;
  childSessions: boolean | null;
}

export type SendResult =
  | { status: 'ok'; appSessionId: string | null }
  | { status: 'busy' }
  /** The user aborted the run in CloudCLI after it was accepted (not a failure; nothing to retry). */
  | { status: 'aborted'; appSessionId: string | null }
  /**
   * `terminal`: this text is how the run itself failed: the /api/agent response status, the route's own failure
   * event, or the provider error immediately before a failing terminal `complete`. Not terminal: anything else (an
   * intermediate error event, a client-side failure). Only terminal failures may be classified as provider quota/rate
   * limits by their generic wording (src/broker/quota.ts).
   */
  | { status: 'error'; error: string; terminal?: boolean };

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
  /**
   * Whether CloudCLI is running a turn in this session right now (app or provider session id).
   * null = unknown: the host lacks the endpoint, or the query failed.
   */
  sessionStatus(sessionId: string): Promise<{ processing: boolean | null }>;
  /** The host's optional Agent API features; a definite answer is cached, an unknown one is asked again next time. */
  capabilities(): Promise<Capabilities>;
}

const HOME = os.homedir();

export class HttpCloudCli implements CloudCli {
  constructor(
    private opts: {
      dbPath?: string;
      pluginsConfigPath?: string;
      localServerPath?: string;
      fetchImpl?: typeof fetch;
      /** Bound on each session-status request; a timeout counts as "unknown" (default 5 s). */
      statusTimeoutMs?: number;
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

  async health(timeoutMs = 2000): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.baseUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
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
          // Never on a continuation: the host would reject a parent that differs from the stored one (400).
          ...(!input.sessionId && input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        }),
      });
    } catch (e) {
      return { status: 'error', error: `CloudCLI unreachable: ${(e as Error).message}` };
    }
    if (res.status === 409) return { status: 'busy' };
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      return { status: 'error', error: `HTTP ${res.status}: ${text.slice(0, 300)}`, terminal: true };
    }
    return readRun(res.body, onAppSessionId, onEvent);
  }

  private caps: { sessionStatus: boolean; childSessions: boolean } | null = null;

  private statusSignal() { return AbortSignal.timeout(this.opts.statusTimeoutMs ?? 5_000); }

  async capabilities(): Promise<Capabilities> {
    if (this.caps) return { ...this.caps };
    const key = this.apiKey();
    if (!key) return { sessionStatus: null, childSessions: null };
    try {
      // A hung CloudCLI must not hang the caller: a timeout means "cannot tell".
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.baseUrl()}/api/agent/capabilities`, {
        headers: { 'x-api-key': key }, signal: this.statusSignal(),
      });
      // Only a definite answer is cached; a failure (or a host without the endpoint) is asked again next time.
      if (!res.ok) return { sessionStatus: null, childSessions: null };
      const j = (await res.json()) as Record<string, unknown>;
      this.caps = { sessionStatus: j.sessionStatus === true, childSessions: j.childSessions === true };
      return { ...this.caps };
    } catch {
      return { sessionStatus: null, childSessions: null };
    }
  }

  async sessionStatus(sessionId: string): Promise<{ processing: boolean | null }> {
    const key = this.apiKey();
    if (!key) return { processing: null };
    const doFetch = this.opts.fetchImpl ?? fetch;
    const headers = { 'x-api-key': key };
    try {
      if ((await this.capabilities()).sessionStatus !== true) return { processing: null };
      const res = await doFetch(`${this.baseUrl()}/api/agent/sessions/${encodeURIComponent(sessionId)}`, { headers, signal: this.statusSignal() });
      // CloudCLI does not know the session, so it cannot be running a turn in it.
      if (res.status === 404) return { processing: false };
      if (!res.ok) return { processing: null };
      const j = (await res.json()) as Record<string, unknown>;
      return { processing: typeof j.processing === 'boolean' ? j.processing : null };
    } catch {
      return { processing: null };
    }
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

/**
 * Reads one /api/agent run stream to its outcome. CloudCLI's contract (shared/utils.js createCompleteMessage): every
 * provider run ends with exactly one `complete` {exitCode, success, aborted}. A provider failure is reported as a
 * `kind: 'error'` event sent right before a failing `complete` (claude-runtime / codex-runtime catch blocks); the route
 * itself reports a run that threw as `{ type: 'error' }` and ends the stream (agent.routes.js). Other error events can
 * appear mid-turn (e.g. a Codex item error while the agent debugs something) and do not end the run.
 *  - a successful `complete` → ok, whatever error events came before it;
 *  - a failing `complete` → error; terminal when an error event immediately preceded it (that is its cause);
 *  - the route's `{ type: 'error' }` → error, terminal;
 *  - no `complete` (older hosts) → error if any error event was seen, terminal only if it was the last thing sent.
 */
export async function readRun(
  body: ReadableStream<Uint8Array>, onAppSessionId?: (id: string) => void, onEvent?: (event: Record<string, unknown>) => void,
): Promise<SendResult> {
  let appSessionId: string | null = null;
  let aborted = false;
  let lastError: string | null = null;
  /** The error event nothing but status/lifecycle events followed (the candidate cause of the run's end). */
  let pendingError: string | null = null;
  let routeError: string | null = null;
  let complete: Record<string, unknown> | null = null;
  for await (const event of sseEvents(body)) {
    // A tab aborted the run: the terminal `complete` says so (createCompleteMessage, shared/utils.ts:535-553), and
    // the route adds { type: 'status', message: 'Run aborted', aborted: true } (agent.routes.ts:834, :1165-1167).
    if (event.aborted === true && (event.kind === 'complete' || event.type === 'status')) aborted = true;
    if (event.type === 'session-id' && typeof event.sessionId === 'string') {
      appSessionId = event.sessionId;
      onAppSessionId?.(appSessionId);
    } else if (event.type === 'error' || event.kind === 'error') {
      lastError = String(event.error ?? event.content ?? event.message ?? 'unknown error');
      pendingError = lastError;
      if (event.type === 'error') routeError = lastError;
    } else {
      if (event.kind === 'complete') complete = event;
      else if (event.kind !== 'status' && event.type !== 'status' && event.type !== 'done') pendingError = null;
      onEvent?.(event);
    }
  }
  if (aborted) return { status: 'aborted', appSessionId };
  if (routeError !== null) return { status: 'error', error: routeError, terminal: true };
  if (complete) {
    const failed = complete.success === false || (typeof complete.exitCode === 'number' && complete.exitCode !== 0);
    if (!failed) return { status: 'ok', appSessionId };
    if (pendingError !== null) return { status: 'error', error: pendingError, terminal: true };
    return { status: 'error', error: lastError ?? `the run failed (exit code ${String(complete.exitCode ?? 'unknown')})`, terminal: false };
  }
  if (lastError === null) return { status: 'ok', appSessionId };
  return { status: 'error', error: lastError, terminal: pendingError !== null };
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
