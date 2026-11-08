// Minimal, dependency-free environment helpers shared by web and worker.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Resolve the configured log level from `LOG_LEVEL`, defaulting to `info`. */
export function getLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = (env.LOG_LEVEL ?? '').trim().toLowerCase();
  return isLogLevel(raw) ? raw : 'info';
}

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export interface IntEnvRange {
  /** Value used when the variable is unset or blank. */
  fallback: number;
  min: number;
  /** Omit when no value is definitionally too large. */
  max?: number;
}

/**
 * A whole-number setting from the environment, or `fallback` when unset.
 *
 * A malformed or out-of-range value THROWS rather than falling back: these
 * variables are ceilings and boundaries, and an operator who mistypes one must
 * not be left believing they raised a limit that is still at its shipped value.
 * (`WORKER_CONCURRENCY` deliberately keeps the opposite policy — it is a
 * throughput knob, not a boundary.)
 *
 * The env bag is typed loosely rather than as `NodeJS.ProcessEnv`: Next augments
 * that interface with a required `NODE_ENV`, so a web-side caller could not pass
 * a plain object of the variables it cares about.
 */
export function readIntEnv(
  name: string,
  range: IntEnvRange,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name]?.trim();
  if (!raw) return range.fallback;
  const value = Number(raw);
  const ceiling = range.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(value) || value < range.min || value > ceiling) {
    const bound =
      range.max === undefined ? `at least ${range.min}` : `between ${range.min} and ${range.max}`;
    throw new Error(`${name} must be a whole number ${bound}, got "${raw}"`);
  }
  return value;
}

/** Read a required string env var, throwing a clear error when it is missing. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
