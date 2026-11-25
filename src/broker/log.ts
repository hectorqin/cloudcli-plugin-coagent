export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  runId?: string;
  agentId?: string;
  turn?: string | number;
  gateId?: string | number;
  [key: string]: unknown;
}

const SECRET_VALUE = /\b(?:ck_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[a-f0-9]{48,})\b|\bBearer\s+[^\s"']+|\b(?:token|api[_-]?key)\s*[:=]\s*[^\s,"'}]+/gi;
const SENSITIVE_KEY = /token|secret|password|cookie|authorization|api[_-]?key/i;
const BODY_KEY = /^(?:prompt|message|body|content|toolInput|text|plan|note|comment|args|result|details)$/i;
const clipped = (s: string, max: number) => s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;

export function redact(value: unknown, key = ''): unknown {
  if (BODY_KEY.test(key)) {
    const length = typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length;
    return { redacted: true, length };
  }
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return clipped(value.replace(SECRET_VALUE, '[REDACTED]'), 2000);
  if (value instanceof Error) return {
    name: value.name,
    message: redact(clipped(value.message, 500)),
    stack: redact(clipped(value.stack ?? '', 2000)),
  };
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export function writeLog(level: LogLevel, msg: string, fields: LogFields = {}, sink: (line: string) => void = console.error) {
  sink(JSON.stringify({ ...redact(fields) as object, ts: new Date().toISOString(), level, msg: redact(msg) }));
}

/** Adapter for Broker's deliberately simple logger dependency. */
export function brokerLog(...args: unknown[]) {
  const [first, ...rest] = args;
  const msg = typeof first === 'string' ? first : 'broker event';
  const fields = rest.length === 1 && rest[0] && typeof rest[0] === 'object'
    ? rest[0] as LogFields
    : rest.length ? { details: rest } : {};
  writeLog(/fail|error/i.test(msg) ? 'error' : 'info', msg, fields);
}
