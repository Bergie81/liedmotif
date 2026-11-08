import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectTestDb,
  GENERATION_FIXTURE_TABLES,
  createGenerationRequest,
  createProviderJob,
  createTrack,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';

// The retention-is-membership backfills, replayed against staged
// legacy flag state: favorited tracks become the owner's Favorites playlist in
// favoritedAt order; saved-but-unfiled tracks are seeded into a one-time "Saved
// tracks" playlist; rejected/deleted rows drop stale flags; and both system
// collections are hidden from the Playlists tab. The statements are executed
// from the committed migration files themselves, so the test fails if the
// shipped SQL drifts from these semantics.

const skip = !TEST_DATABASE_URL;
/** Files retention flags into playlists. */
const MEMBERSHIP_MIGRATION = '0046_playlists.sql';
/** Hides the system collections from the Playlists tab. */
const VISIBILITY_MIGRATION = '0049_robust_jack_murdock.sql';

let testDb: TestDb;

/** The data statements of a committed migration (its DDL and comments dropped). */
function backfillStatements(migrationFile: string): string[] {
  const sql = readFileSync(join(__dirname, '../../drizzle', migrationFile), 'utf8');
  return sql
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.startsWith('INSERT') || statement.startsWith('UPDATE'));
}

async function runBackfill(migrationFile: string): Promise<void> {
  for (const statement of backfillStatements(migrationFile)) {
    await testDb.pool.query(statement);
  }
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('playlist-backfill-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES]);
});

async function seedFlaggedTrack(
  ownerUserId: string,
  flags: {
    savedAt?: Date;
    favoritedAt?: Date;
    status?: 'ready' | 'rejected' | 'deleted';
  },
): Promise<string> {
  const requestId = await createGenerationRequest(testDb.db, { ownerUserId });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    status: flags.status ?? 'ready',
    savedAt: flags.savedAt ?? null,
    favoritedAt: flags.favoritedAt ?? null,
  });
}

describe.skipIf(skip)('playlist retention backfills', () => {
  it('files retained tracks, hides system collections, and preserves ordinary playlist visibility', async () => {
    const owner = await createUser(testDb.db);
    const favLate = await seedFlaggedTrack(owner, {
      savedAt: new Date('2026-07-01T00:00:00Z'),
      favoritedAt: new Date('2026-07-02T00:00:00Z'),
    });
    const favEarly = await seedFlaggedTrack(owner, {
      savedAt: new Date('2026-07-01T00:00:00Z'),
      favoritedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const savedOnly = await seedFlaggedTrack(owner, {
      savedAt: new Date('2026-07-03T00:00:00Z'),
    });
    const staleRejected = await seedFlaggedTrack(owner, {
      savedAt: new Date('2026-07-01T00:00:00Z'),
      favoritedAt: new Date('2026-07-01T00:00:00Z'),
      status: 'rejected',
    });

    await runBackfill(MEMBERSHIP_MIGRATION);
    await testDb.pool.query(
      `insert into playlists (owner_user_id, name, kind) values ($1, 'Focus', 'user')`,
      [owner],
    );
    await runBackfill(VISIBILITY_MIGRATION);

    const playlists = await testDb.pool.query(
      `select id, kind, name, listed_in_playlists from playlists where owner_user_id = $1 order by name`,
      [owner],
    );
    expect(playlists.rows.map((r) => [r.kind, r.name, r.listed_in_playlists])).toEqual([
      ['favorites', 'Favorites', false],
      ['user', 'Focus', true],
      ['user', 'Saved tracks', false],
    ]);

    const favorites = playlists.rows.find((r) => r.kind === 'favorites')!;
    const favMembers = await testDb.pool.query(
      `select track_id from playlist_tracks where playlist_id = $1 order by position`,
      [favorites.id],
    );
    expect(favMembers.rows.map((r) => r.track_id)).toEqual([favEarly, favLate]);

    const saved = playlists.rows.find((r) => r.name === 'Saved tracks')!;
    const savedMembers = await testDb.pool.query(
      `select track_id from playlist_tracks where playlist_id = $1 order by position`,
      [saved.id],
    );
    expect(savedMembers.rows.map((r) => r.track_id)).toEqual([savedOnly]);

    const stale = await testDb.pool.query(
      `select saved_at, favorited_at from tracks where id = $1`,
      [staleRejected],
    );
    expect(stale.rows[0]).toEqual({ saved_at: null, favorited_at: null });
    const staleMemberships = await testDb.pool.query(
      `select count(*)::int as n from playlist_tracks where track_id = $1`,
      [staleRejected],
    );
    expect(staleMemberships.rows[0].n).toBe(0);
  });

  it('is a no-op for an owner with no flagged tracks (no empty playlists minted)', async () => {
    const owner = await createUser(testDb.db);
    await seedFlaggedTrack(owner, {});
    await runBackfill(MEMBERSHIP_MIGRATION);
    const playlists = await testDb.pool.query(
      `select count(*)::int as n from playlists where owner_user_id = $1`,
      [owner],
    );
    expect(playlists.rows[0].n).toBe(0);
  });
});
