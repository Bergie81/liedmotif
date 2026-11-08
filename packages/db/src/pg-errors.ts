// The one place that digs a Postgres error out of a driver/ORM error chain.
// Drizzle and pg re-throw with the original attached under `cause` (sometimes
// nested), so callers probing for a SQLSTATE or a violated constraint walk the
// chain here rather than each keeping their own walker.

export interface PgErrorFacts {
  /** SQLSTATE, e.g. `23505` for unique_violation. */
  code?: string;
  /** The violated constraint's name, when the driver reports one. */
  constraint?: string;
}

/** The first chain link carrying a string `code`, as `{ code, constraint }`. */
export function pgErrorFacts(error: unknown): PgErrorFacts {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null) return {};
    const { code, constraint, cause } = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string') {
      return { code, ...(typeof constraint === 'string' ? { constraint } : {}) };
    }
    current = cause;
  }
  return {};
}

/** True when the error chain carries the `user.email` unique violation. */
export function isEmailUniqueViolation(error: unknown): boolean {
  const { code, constraint } = pgErrorFacts(error);
  return code === '23505' && (constraint?.includes('email') ?? false);
}

/** The chain's SQLSTATE, or undefined when none is found. */
export function sqlState(error: unknown): string | undefined {
  return pgErrorFacts(error).code;
}
