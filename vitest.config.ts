import { fileURLToPath } from 'node:url';
import { config as loadEnvFile } from 'dotenv';
import { defineConfig } from 'vitest/config';

// `.env` is the one place this repo keeps `TEST_DATABASE_URL`, and ~a third of the
// suite gates itself on that variable — without it those files SKIP instead of
// failing, so a local run silently proves less than CI does. Loading it here makes
// `npm test` the same gate everywhere. `override` stays off so a real environment
// variable always wins (CI points `TEST_DATABASE_URL` at its own service container),
// and a missing `.env` is a no-op rather than an error, which is what Docker builds
// and CI checkouts see.
loadEnvFile({
  path: fileURLToPath(new URL('./.env', import.meta.url)),
  override: false,
  quiet: true,
});

// Root Vitest config for unit + integration tests across packages, the worker, and
// the web app's server/client modules (api-client, app-route handlers). The web
// app's browser audio qualification runs under Playwright (`npm run test:e2e`)
// and is intentionally excluded here.
export default defineConfig({
  // The app's `.tsx` components never import `React`, because Next compiles JSX
  // with the automatic runtime. Tests that render one need the same transform.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    // Mirror the web app's `@/*` -> apps/web path alias so its modules (and the
    // route handlers under test) resolve the same way they do under Next.
    alias: [
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL('./apps/web/', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    globals: false,
    include: [
      'packages/**/src/**/*.{test,spec}.ts',
      'packages/providers/scripts/**/*.{test,spec}.ts',
      'apps/worker/**/*.{test,spec}.ts',
      // Web unit/integration tests use `.test.ts`; Playwright browser specs use
      // `.spec.ts` under `tests/e2e` and stay out of the Vitest run.
      'apps/web/**/*.test.ts',
      // The self-hosting shell scripts (the backup loop's schedule and retry
      // behavior) are covered from here too — they ship in the stack and have
      // no package of their own.
      'docker/**/*.test.ts',
      // Root operator scripts (`npm run backup:restore`).
      'scripts/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'apps/web/tests/e2e/**'],
    // Run test files sequentially. The integration suites share one test Postgres
    // (TEST_DATABASE_URL), and the migrate-from-clean suite DROPs whole schemas in
    // its setup — running files in parallel would let that drop race another
    // suite's queries. Sequential files keep each suite's setup authoritative.
    fileParallelism: false,
    // ...and two whole runs (two terminals, parallel agents) queue on a lock in that
    // database rather than truncating each other's tables.
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
