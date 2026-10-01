/**
 * Structured JSON logging. Only allow-listed, non-sensitive fields are emitted.
 * Request bodies, translation text, cookies, tokens and credentials are never
 * passed to the logger; as a second line of defence, keys that look sensitive
 * are redacted.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

const SENSITIVE_KEY = /pass|secret|token|cookie|authorization|text|body|email|card|cvv|key/i;
const ALLOWED_SENSITIVE_LOOKING = new Set(['idempotencyKeyPresent', 'errorCode', 'routeKey']);

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function sanitizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = SENSITIVE_KEY.test(k) && !ALLOWED_SENSITIVE_LOOKING.has(k) ? '[redacted]' : v;
  }
  return out;
}

export function createLogger(
  base: LogFields = {},
  sink: (line: string, level: LogLevel) => void = defaultSink,
  minLevel: LogLevel = 'info',
): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  return {
    log(level, event, fields = {}) {
      if (order[level] < order[minLevel]) return;
      sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...sanitizeFields({ ...base, ...fields }) }), level);
    },
    child(fields) {
      return createLogger({ ...base, ...fields }, sink, minLevel);
    },
  };
}

function defaultSink(line: string, level: LogLevel): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const silentLogger: Logger = { log() {}, child() { return silentLogger; } };
