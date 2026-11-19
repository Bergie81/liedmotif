// This file runs in the parallel `isolated` Vitest project. A file there that
// opened the test Postgres, the S3 test server or Mailpit would race the
// sequential `shared-state` files, so each of those resources must fail it loudly
// with the fix in the message, and never make it skip.

import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assertSafeTestDatabase, connectTestDb, TEST_DATABASE_URL } from '@liedmotif/db/testing';

const FIX = /add it to SHARED_STATE_FILES in vitest\.config\.ts/;
const SHARED_RESOURCES = [
  'TEST_DATABASE_URL',
  'TEST_S3_ENDPOINT',
  'TEST_SMTP_URL',
  'TEST_MAILPIT_URL',
] as const;

describe('a test file in the isolated project', () => {
  it('fails on opening the test database, naming the fix', async () => {
    expect(() => assertSafeTestDatabase(TEST_DATABASE_URL)).toThrow(FIX);
    await expect(connectTestDb('liedmotif-isolated-guard-test')).rejects.toThrow(FIX);
  });

  it('still sees every shared resource set, so gated files run instead of skipping', () => {
    for (const name of SHARED_RESOURCES) {
      expect(process.env[name], name).toBeTruthy();
    }
  });

  it('reaches no shared resource directly: each points at a host named for the fix', async () => {
    for (const name of SHARED_RESOURCES) {
      expect(new URL(process.env[name]!).hostname, name).toBe(
        'move-this-file-to-shared-state-in-vitest-config.invalid',
      );
    }
    const client = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
      connectionTimeoutMillis: 3_000,
    });
    await expect(client.connect()).rejects.toThrow(/move-this-file-to-shared-state/);
  });
});
