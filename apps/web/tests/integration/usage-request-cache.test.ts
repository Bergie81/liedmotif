// The layout chrome and the settings hub share ONE
// request-scoped usage computation (`cachedOwnerUsageTracks`), so both readouts
// derive from a single `now` and can never straddle a budget-window boundary.
//
// React's per-request cache store does not exist under vitest (there `cache` is
// a pass-through), so the request scope is simulated with an args-keyed memo.
// What this proves is OUR wiring: every consumer goes through the same cached
// seam with the same key and therefore receives the identical readout.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    // Arg-identity trie, mirroring React's own cache keying (object args — the
    // db handle — key by reference, primitives by value).
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
      const RESULT = Symbol('result');
      const root = new Map<unknown, never>();
      return (...args: A): R => {
        let node: Map<unknown, unknown> = root;
        for (const arg of args) {
          if (!node.has(arg)) node.set(arg, new Map());
          node = node.get(arg) as Map<unknown, unknown>;
        }
        if (!node.has(RESULT)) node.set(RESULT, fn(...args));
        return node.get(RESULT) as R;
      };
    },
  };
});

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/providers/providers', () => ({ getTypicalTracksPerMusicRequest: () => 2 }));

const { loadAppChrome } = await import('@/lib/app-chrome');
const { cachedOwnerUsageTracks } = await import('@/lib/sessions/sessions');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('usage-request-cache-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings']);
});

describe.skipIf(skip)('request-scoped usage computation', () => {
  it('layout chrome and a settings read resolve to the SAME readout object', async () => {
    const owner = await createUser(testDb.db);
    const chrome = await loadAppChrome(testDb.db as never, owner);
    // The settings hub's music-usage read (same key: db + owner + tracksPerCall).
    const settingsUsage = await cachedOwnerUsageTracks(testDb.db as never, owner, 2);
    expect(settingsUsage).toBe(chrome.usage);
  });

  it('keys per user: another owner gets their own computation', async () => {
    const a = await createUser(testDb.db);
    const b = await createUser(testDb.db);
    const usageA = await cachedOwnerUsageTracks(testDb.db as never, a, 2);
    const usageB = await cachedOwnerUsageTracks(testDb.db as never, b, 2);
    expect(usageB).not.toBe(usageA);
  });
});
