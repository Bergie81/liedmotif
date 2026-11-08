// Test-only surface of `@liedmotif/db` (the `@liedmotif/db/testing` subpath).
//
// Re-exports the shared integration helpers (`connectTestDb`, `truncateTables`,
// `TEST_DATABASE_URL`) and the generation-domain fixture builders so OTHER
// packages' integration suites (the worker controller tests) can stage real
// Postgres state without re-implementing the dependency chain. Never imported by
// runtime code — only by `*.test.ts` files gated on `TEST_DATABASE_URL`.

export {
  connectTestDb,
  truncateTables,
  assertSafeTestDatabase,
  TEST_DATABASE_URL,
  type TestDb,
} from './test-support';
export * from './generation/test-fixtures';
