// The byte total the storage quota is enforced against.
// Every table that records stored bytes has to be in the sum: one left out is a
// quota that never trips for that whole category, which is exactly the silent
// failure the configured number was supposed to prevent.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  connectTestDb,
  GENERATION_FIXTURE_TABLES,
  seedReadyTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from './testing';
import {
  coverImages,
  people,
  personReferencePhotos,
  voiceProfiles,
  voiceRecordings,
} from './schema';
import {
  getStorageUsage,
  isStorageQuotaReached,
  measureStoredBytes,
  refreshStorageUsage,
  reserveStorageBytes,
  settleStorageBytes,
} from './storage-usage';

const skip = !TEST_DATABASE_URL;
let ctx: TestDb;

const TABLES = [
  ...GENERATION_FIXTURE_TABLES,
  'voice_recordings',
  'voice_profiles',
  'person_reference_photos',
  'people',
  'cover_images',
  'app_settings',
];

/** A stored cover: the original object and its derived tile both hold bytes. */
async function seedCover(byteSize: number | null, renditionByteSize: number | null): Promise<void> {
  await ctx.db.insert(coverImages).values({
    sourceType: 'uploaded',
    storageProvider: 'local-fs',
    storageKey: `covers/${randomUUID()}.webp`,
    byteSize,
    renditionByteSize,
  });
}

beforeAll(async () => {
  if (skip) return;
  ctx = await connectTestDb('storage-usage-test');
});
afterAll(async () => {
  if (skip) return;
  await ctx.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(ctx.pool, TABLES);
});

describe.skipIf(skip)('measureStoredBytes', () => {
  it('is zero on an empty instance', async () => {
    expect(await measureStoredBytes(ctx.db)).toBe(0);
  });

  it('sums audio assets, reference photos, voice recordings, and covers', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(ctx.db);
    await ctx.db.execute(
      sql`update track_audio_assets set byte_size = 1000 where track_id = ${trackId}`,
    );

    const [person] = await ctx.db
      .insert(people)
      .values({ ownerUserId, role: 'ordinary', name: 'Ada', nameMatchKey: 'ada', sortOrder: 0 })
      .returning({ id: people.id });
    await ctx.db.insert(personReferencePhotos).values({
      ownerUserId,
      personId: person!.id,
      storageProvider: 'local-fs',
      storageKey: 'people/photo.webp',
      mediaType: 'image/webp',
      byteSize: 200,
    });

    const [profile] = await ctx.db
      .insert(voiceProfiles)
      .values({
        ownerUserId,
        displayName: 'Voice',
        providerKey: 'mock',
        consentVersion: 'v1',
        consentAcceptedAt: new Date(),
      })
      .returning({ id: voiceProfiles.id });
    await ctx.db.insert(voiceRecordings).values({
      ownerUserId,
      voiceProfileId: profile!.id,
      kind: 'verification',
      storageProvider: 'local-fs',
      storageKey: 'voice/rec.wav',
      mimeType: 'audio/wav',
      byteSize: 30,
    });

    await seedCover(60, 6);
    // A cover written before the byte columns existed contributes nothing.
    await seedCover(null, null);

    expect(await measureStoredBytes(ctx.db)).toBe(1296);
  });

  it('ignores audio rows that hold no stored bytes (provider URLs only)', async () => {
    const { trackId } = await seedReadyTrack(ctx.db);
    await ctx.db.execute(
      sql`update track_audio_assets set byte_size = 500, storage_key = null where track_id = ${trackId}`,
    );
    expect(await measureStoredBytes(ctx.db)).toBe(0);
  });
});

describe.skipIf(skip)('reserveStorageBytes', () => {
  /** Put a known measured total in place, the way the hourly sweep would. */
  async function seedMeasuredTotal(totalBytes: number): Promise<void> {
    await seedCover(totalBytes, null);
    await refreshStorageUsage(ctx.db);
  }

  it('refuses a write that would cross the quota while the total is still under it', async () => {
    await seedMeasuredTotal(900);
    expect(await reserveStorageBytes(ctx.db, { bytes: 200, quotaBytes: 1000 })).toBeNull();
    expect(await reserveStorageBytes(ctx.db, { bytes: 100, quotaBytes: 1000 })).not.toBeNull();
  });

  it('admits only as many concurrent reservations as jointly fit', async () => {
    await seedMeasuredTotal(0);
    const attempts = await Promise.all([
      reserveStorageBytes(ctx.db, { bytes: 600, quotaBytes: 1000 }),
      reserveStorageBytes(ctx.db, { bytes: 600, quotaBytes: 1000 }),
    ]);
    expect(attempts.filter((reservation) => reservation !== null)).toHaveLength(1);
  });

  it('accounts what was written and frees the reservation for the next writer', async () => {
    await seedMeasuredTotal(0);
    const reservation = await reserveStorageBytes(ctx.db, { bytes: 900, quotaBytes: 1000 });
    await settleStorageBytes(ctx.db, reservation!, 100);

    expect((await getStorageUsage(ctx.db))?.totalBytes).toBe(100);
    expect(await reserveStorageBytes(ctx.db, { bytes: 900, quotaBytes: 1000 })).not.toBeNull();
  });

  it('frees the whole reservation when nothing was written', async () => {
    await seedMeasuredTotal(0);
    const reservation = await reserveStorageBytes(ctx.db, { bytes: 1000, quotaBytes: 1000 });
    await settleStorageBytes(ctx.db, reservation!, 0);

    expect((await getStorageUsage(ctx.db))?.totalBytes).toBe(0);
    expect(await reserveStorageBytes(ctx.db, { bytes: 1000, quotaBytes: 1000 })).not.toBeNull();
  });

  it('admits before anything has measured the total', async () => {
    expect(await getStorageUsage(ctx.db)).toBeNull();
    expect(await reserveStorageBytes(ctx.db, { bytes: 10_000, quotaBytes: 1 })).not.toBeNull();
  });

  it('agrees with the purchase gate on exactly where the quota runs out of room', async () => {
    // The buffer buys audio only when the gate says its write would fit; a gate
    // looser than the reservation pays for tracks whose download is then refused.
    await seedMeasuredTotal(900);
    const usage = await getStorageUsage(ctx.db);

    expect(isStorageQuotaReached(usage, 999, 100)).toBe(true);
    expect(await reserveStorageBytes(ctx.db, { bytes: 100, quotaBytes: 999 })).toBeNull();

    expect(isStorageQuotaReached(usage, 1000, 100)).toBe(false);
    expect(await reserveStorageBytes(ctx.db, { bytes: 100, quotaBytes: 1000 })).not.toBeNull();
  });
});

describe.skipIf(skip)('refreshStorageUsage', () => {
  it('caches the measured total for readers that must never re-measure', async () => {
    expect(await getStorageUsage(ctx.db)).toBeNull();

    const { trackId } = await seedReadyTrack(ctx.db);
    await ctx.db.execute(
      sql`update track_audio_assets set byte_size = 42 where track_id = ${trackId}`,
    );
    const written = await refreshStorageUsage(ctx.db);
    expect(written.totalBytes).toBe(42);

    const cached = await getStorageUsage(ctx.db);
    expect(cached?.totalBytes).toBe(42);
    expect(Date.parse(cached!.measuredAt)).not.toBeNaN();
  });
});
