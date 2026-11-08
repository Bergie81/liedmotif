// Structured JSON logger writing one JSON object per line to stdout, with a
// logger-level redaction filter so secrets, credentials, and provider URLs never
// reach the logs. This is the single logging entry point for web and worker.
//
// Redaction is enforced *inside* the logger (not at call sites) so a caller can
// never accidentally log a secret by passing it through: logs must not leak
// keys, signed URLs, or sensitive prompts.

import { getLogLevel, type LogLevel } from './env';

export const REDACTED = '[REDACTED]';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Field-name fragments that mark a value as sensitive. Matching is done on the
 * key lowercased with non-alphanumeric characters stripped, so `api_key`,
 * `apiKey`, and `API-KEY` all match `apikey`.
 */
export const DEFAULT_SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'authorization',
  // Narrow auth fragments — deliberately NOT bare `auth`, which would also redact
  // benign `author`/`authorName` fields the app tracks.
  'authtoken',
  'authheader',
  'credential',
  'cookie',
  'encryptionkey',
  'privatekey',
  'signedurl',
  'bearer',
  // Database/connection strings carry inline `user:password@host` credentials.
  'connectionstring',
  'connstring',
  'databaseurl',
  'dsn',
  // Prompt content can contain sensitive/private text, which logs must not leak.
  // Redacting `promptId`-style metadata too is a safe default.
  'prompt',
  // Provider audio URLs must stay server-side and never be serialized/logged.
  'audiourl',
  'streamaudiourl',
  'streamurl',
  'sourceurl',
  'encryptedsourceurl',
];

/**
 * Strips inline URL userinfo (`scheme://user:password@host` OR `scheme://token@host`
 * -> `scheme://[REDACTED]@host`) in ANY string field, so neither a connection
 * string's password nor a token-as-username leaks even when the field name isn't
 * recognized as sensitive. The required `://` (and userinfo containing no `/`)
 * keeps bare emails / `mailto:` in prose untouched. Userinfo excludes `?`/`#`
 * (query/fragment delimiters), so a `scheme://host?x=a@b` query form isn't matched.
 */
const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi;

/**
 * Patterns wholly replaced with REDACTED inside string values, by field name or
 * not — so a secret leaks neither under an unrecognized key nor embedded in prose.
 * High-confidence formats only, to avoid false positives on benign text.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g, // OpenAI / OpenRouter style keys (allow `_`)
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT (header.payload.signature)
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
];

/**
 * A URL and everything after it up to whitespace, capturing only the part before
 * `?`/`#`. Provider signatures ride in the query (Suno's expiring audio links,
 * S3's `X-Amz-Signature`), so the query is dropped from every logged string —
 * the host and path stay, which is what a log line is read for.
 */
const URL_WITH_QUERY = /([a-z][a-z0-9+.-]*:\/\/[^\s?#'"<>]+)[^\s'"<>]*/gi;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Strip inline URL credentials, query strings, and bearer/sk-style secrets. */
function redactSecretsInString(value: string): string {
  // A URL keeps its scheme, host and path: only the embedded credentials and the
  // query are removed, so the line still says what was talked to.
  let out = value.replace(URL_CREDENTIALS_PATTERN, `$1${REDACTED}@`).replace(URL_WITH_QUERY, '$1');
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * A Drizzle query error's message is `Failed query: <sql>\nparams: <values>`, and
 * the bound values are user prompts, style snapshots and the like — which may span
 * lines, so no line-based string rule can cut them. The error keeps the SQL apart
 * in `query`, so the message is rebuilt from that alone.
 */
function withoutQueryParams(error: Error): string {
  const { query, params } = error as Error & { query?: unknown; params?: unknown };
  if (typeof query !== 'string' || params === undefined) return error.message;
  return `Failed query: ${query}\nparams: ${REDACTED}`;
}

export interface RedactorOptions {
  /** Field-name fragments whose values are wholly replaced with REDACTED. */
  sensitiveKeyFragments?: readonly string[];
}

/**
 * Build a recursive redactor. The default (`redact`) is what the logger uses;
 * callers that persist provider diagnostics build a tuned one (a fragment list
 * that keeps prompts). Cycles are broken with a WeakSet, a depth cap keeps
 * pathological inputs cheap, and Errors become a plain serializable shape so
 * stack traces still appear without leaking enumerable secret props.
 */
export function createRedactor(options: RedactorOptions = {}): (input: unknown) => unknown {
  const fragments = options.sensitiveKeyFragments ?? DEFAULT_SENSITIVE_KEY_FRAGMENTS;

  function isSensitiveKey(key: string): boolean {
    const normalized = normalizeKey(key);
    return fragments.some((fragment) => normalized.includes(fragment));
  }

  function walk(input: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (depth > 8) return '[Truncated]';
    if (typeof input === 'string') return redactSecretsInString(input);
    if (input === null || typeof input !== 'object') return input;

    if (input instanceof Error) {
      // `Error.stack` embeds the message in its first line, so a secret in the
      // message survives in the stack unless the stack is redacted too.
      const message = withoutQueryParams(input);
      return {
        name: input.name,
        message: redactSecretsInString(message),
        stack:
          typeof input.stack === 'string'
            ? redactSecretsInString(input.stack.split(input.message).join(message))
            : input.stack,
      };
    }

    if (seen.has(input)) return '[Circular]';
    seen.add(input);

    if (Array.isArray(input)) {
      return input.map((item) => walk(item, seen, depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      result[key] = isSensitiveKey(key) ? REDACTED : walk(value, seen, depth + 1);
    }
    return result;
  }

  return (input) => walk(input, new WeakSet(), 0);
}

/** Default redactor used by the logger: strips secrets, credentials, and prompts. */
export const redact = createRedactor();

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  /** Service/component name attached to every line, e.g. `web` or `worker`. */
  name?: string;
  /** Minimum level to emit. Defaults to `LOG_LEVEL` env (then `info`). */
  level?: LogLevel;
  /** Static fields merged into every line (also redacted). */
  base?: LogFields;
  /** Output sink. Defaults to stdout. Injectable for tests. */
  sink?: (line: string) => void;
  /** Clock, injectable for tests. Defaults to wall-clock ISO timestamps. */
  now?: () => string;
}

function defaultSink(line: string): void {
  process.stdout.write(line + '\n');
}

function defaultNow(): string {
  return new Date().toISOString();
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? getLogLevel();
  const threshold = LEVEL_PRIORITY[level];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? defaultNow;
  const base = options.base ?? {};
  const name = options.name;

  function emit(entryLevel: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_PRIORITY[entryLevel] < threshold) return;
    const record: LogFields = {
      time: now(),
      level: entryLevel,
      ...(name ? { name } : {}),
      msg,
      ...base,
      ...(fields ?? {}),
    };
    const safe = redact(record);
    sink(JSON.stringify(safe));
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (bindings) => createLogger({ ...options, level, base: { ...base, ...bindings } }),
  };
}
