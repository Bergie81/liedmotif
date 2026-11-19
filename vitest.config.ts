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

const INCLUDE = [
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
];
const EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/.next/**', 'apps/web/tests/e2e/**'];

// Files that use the test Postgres, the S3 test server or Mailpit. Every other
// file runs in parallel in the `isolated` project, where those resources point
// at an unreachable host, so a file missing from this list fails, never races.
const SHARED_STATE_FILES = [
  'packages/db/src/**/*.{test,spec}.ts',
  'apps/worker/src/jobs/**/*.test.ts',
  'apps/worker/src/session-cover/**/*.test.ts',
  'apps/worker/src/analysis-polling-slo.test.ts',
  'apps/web/tests/integration/**/*.test.ts',
  'docker/backup-due.test.ts',
  'packages/storage/src/s3.test.ts',
  'packages/providers/src/email/smtp.test.ts',
];

// Kept in step with `ISOLATED_PROJECT_HOST` in packages/db/src/test-support.ts,
// which turns a database connection to it into an error that names the fix.
const ISOLATED_PROJECT_HOST = 'move-this-file-to-shared-state-in-vitest-config.invalid';

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
    // Two whole runs (two terminals, parallel agents) queue on a lock in the test
    // database rather than truncating each other's tables.
    globalSetup: ['./vitest.global-setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'shared-state',
          include: SHARED_STATE_FILES,
          exclude: EXCLUDE,
          // Run these files one at a time. They share one test Postgres
          // (TEST_DATABASE_URL), and the migrate-from-clean suite DROPs whole
          // schemas in its setup — running them in parallel would let that drop
          // race another suite's queries. Sequential files keep each suite's
          // setup authoritative.
          fileParallelism: false,
          // Vitest runs projects with different worker counts one after the
          // other, never side by side; this fixes the order.
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'isolated',
          include: INCLUDE,
          exclude: [...EXCLUDE, ...SHARED_STATE_FILES],
          // Half the cores, so tests that wait on real time keep headroom.
          maxWorkers: '50%',
          sequence: { groupOrder: 2 },
          // Replaced, never unset: an unset variable would make a misplaced file
          // skip silently instead of failing.
          env: {
            TEST_DATABASE_URL: `postgres://test@${ISOLATED_PROJECT_HOST}/liedmotif_test`,
            TEST_S3_ENDPOINT: `http://${ISOLATED_PROJECT_HOST}`,
            TEST_SMTP_URL: `smtp://${ISOLATED_PROJECT_HOST}:1025`,
            TEST_MAILPIT_URL: `http://${ISOLATED_PROJECT_HOST}`,
          },
        },
      },
    ],
  },
});
