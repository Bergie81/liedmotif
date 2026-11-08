// Database-name safety guards shared by the app runtime and the test suites.
//
// The repo's data-loss invariant is enforced from both directions:
//
//   - Test suites (integration + e2e) refuse to run unless their target database
//     name contains "test" — they truncate tables and drop schemas, so the target
//     must be a throwaway (`assertSafeTestDatabase` in `test-support.ts`, plus
//     a deliberately inline gate in the migrate-from-clean suite).
//   - The app runtime (web, worker, and the app-DB CLI scripts) refuses to run
//     when `DATABASE_URL` names a database containing "test"
//     (`assertNotTestDatabase` below).
//
// Together these make it impossible for the app and the destructive test suites
// to share a database, regardless of which env vars are visible in which process.
// The one sanctioned exception is the Playwright e2e harness, which deliberately
// boots the real app against the throwaway e2e database and opts out by setting
// `LIEDMOTIF_ALLOW_TEST_DATABASE` to that database's exact name.
//
// The "contains test" match is intentionally coarse (it would reject a database
// named `contest` or `latest`): a false refusal costs a rename, a false pass
// costs the admin account. Tighten to explicit `_test`/`-test` patterns only if
// this ever bites in practice.

/**
 * Pull the database name (URL path, minus the leading slash, percent-decoded)
 * out of a URL-style connection string. Returns undefined when the string is not
 * a URL or carries no database name — `DATABASE_URL` is URL-style everywhere in
 * this repo (pg keyword/value strings are not supported).
 */
export function databaseNameOf(databaseUrl: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Whether the connection string names a database that looks like a test database. */
export function isTestDatabaseUrl(databaseUrl: string): boolean {
  return databaseNameOf(databaseUrl)?.toLowerCase().includes('test') ?? false;
}

/**
 * Fail-closed guard for the app runtime: throw when `DATABASE_URL` names a
 * database that looks like a test database, or when the database name cannot be
 * determined from a non-empty value. The test suites treat any `*test*` database
 * as a disposable target, so an app pointed at one would have its data silently
 * wiped by the next `npm test` run.
 *
 * Empty values pass through — presence is validated by each caller. The opt-out
 * for the Playwright e2e harness (which boots the app against a throwaway
 * database on purpose) is scoped, not a kill-switch: the guard passes only when
 * `LIEDMOTIF_ALLOW_TEST_DATABASE` equals the exact database name being refused,
 * so a stray `=1` in some environment cannot reopen the guard for anything.
 */
export function assertNotTestDatabase(databaseUrl: string): void {
  if (!databaseUrl) return;
  const databaseName = databaseNameOf(databaseUrl);
  if (!databaseName) {
    throw new Error(
      'Could not determine the database name from DATABASE_URL (expected a URL like ' +
        'postgres://user:pass@host:5432/dbname). Refusing to start rather than risk ' +
        'targeting a test database.',
    );
  }
  if (databaseName.toLowerCase().includes('test')) {
    if (process.env.LIEDMOTIF_ALLOW_TEST_DATABASE === databaseName) return;
    throw new Error(
      `Refusing to use database "${databaseName}" as the app database: its name contains ` +
        '"test", so the test suites treat it as a throwaway target (they truncate tables ' +
        'and drop schemas). Point DATABASE_URL at a non-test database (e.g. liedmotif_dev), ' +
        `or set LIEDMOTIF_ALLOW_TEST_DATABASE=${databaseName} only for a disposable ` +
        'e2e/test instance.',
    );
  }
}
