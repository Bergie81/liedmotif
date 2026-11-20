import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  createDb,
  createPlaylist,
  coverImages,
  createPool,
  insertGeneratedCoverImage,
  insertGeneratedPlaylistCoverImage,
  reservePlaylistCoverRegeneration,
  reserveSessionCoverRegeneration,
  sessionCoverGenerations,
  updateUsageLimits,
  userProfiles,
  type Database,
} from '@liedmotif/db';
import { MAX_PLAYLIST_COVER_HISTORY, MAX_SESSION_COVER_HISTORY } from '@liedmotif/shared';
import type { Pool } from 'pg';

// The one read-only gate both cover regenerate routes and the Assistant ask
// before a paid cover attempt. Every call runs on a read-only connection, so a
// write anywhere in the gate fails the test.

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));

const { coverAttemptGate } = await import('@/lib/covers/cover-attempt-gate');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
let readOnlyPool: Pool;
let readOnlyDb: Database;

type Subject = { kind: 'session'; id: string } | { kind: 'playlist'; id: string };

const SUBJECTS = [
  { kind: 'session', max: MAX_SESSION_COVER_HISTORY, fullMessage: /This session already keeps/ },
  { kind: 'playlist', max: MAX_PLAYLIST_COVER_HISTORY, fullMessage: /This playlist already keeps/ },
] as const;

function readOnlyUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', '-c default_transaction_read_only=on');
  return parsed.toString();
}

async function seedSubject(kind: Subject['kind'], ownerUserId: string): Promise<Subject> {
  if (kind === 'session') {
    return { kind, id: await createSession(testDb.db, { ownerUserId }) };
  }
  const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Gate fixture' });
  return { kind, id: playlist.id };
}

/** A reserved (live) attempt on the subject. */
async function seedLiveAttempt(ownerUserId: string, subject: Subject): Promise<string> {
  const id = randomUUID();
  const coverImageId = randomUUID();
  const reserved =
    subject.kind === 'session'
      ? await reserveSessionCoverRegeneration(testDb.db, {
          id,
          ownerUserId,
          activitySessionId: subject.id,
          coverImageId,
          storageKey: `covers/generated/${ownerUserId}/${subject.id}/${coverImageId}.webp`,
        })
      : await reservePlaylistCoverRegeneration(testDb.db, {
          id,
          ownerUserId,
          playlistId: subject.id,
          coverImageId,
          storageKey: `covers/generated-playlists/${ownerUserId}/${subject.id}/${coverImageId}.webp`,
          coverStyle: 'minimal',
        });
  expect(reserved).not.toBeNull();
  return id;
}

/** A settled, servable generated cover in the subject's history. */
async function seedReadyCover(ownerUserId: string, subject: Subject) {
  const id = await seedLiveAttempt(ownerUserId, subject);
  const [row] = await testDb.db
    .update(sessionCoverGenerations)
    .set({ state: 'ready', settledAt: new Date() })
    .where(eq(sessionCoverGenerations.id, id))
    .returning();
  const base = {
    id: row!.coverImageId!,
    ownerUserId,
    storageProvider: 'local-fs',
    storageKey: row!.storageKey!,
    byteSize: 1,
    label: 'Gate fixture cover',
    model: 'test-model',
  };
  if (subject.kind === 'session') {
    await insertGeneratedCoverImage(testDb.db, {
      ...base,
      activitySessionId: subject.id,
      activityFit: [],
      moodFit: [],
      genreFit: [],
      energyFit: [],
    });
  } else {
    await insertGeneratedPlaylistCoverImage(testDb.db, {
      ...base,
      playlistId: subject.id,
      visualTheme: 'minimal',
    });
  }
}

/** An owner-uploaded cover in the subject's history. */
async function seedUploadedCover(ownerUserId: string, subject: Subject) {
  const coverImageId = randomUUID();
  await testDb.db.insert(coverImages).values({
    id: coverImageId,
    sourceType: 'uploaded',
    storageProvider: 'local-fs',
    storageKey: `covers/uploaded/${ownerUserId}/${coverImageId}.webp`,
    tags: { label: 'Gate fixture upload' },
    provenance:
      subject.kind === 'session'
        ? { ownerUserId, activitySessionId: subject.id }
        : { ownerUserId, playlistId: subject.id },
  });
}

async function attemptCount(): Promise<number> {
  return (await testDb.db.select({ id: sessionCoverGenerations.id }).from(sessionCoverGenerations))
    .length;
}

function gate(ownerUserId: string, subject: Subject) {
  return coverAttemptGate(readOnlyDb, { ownerUserId, subject });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('cover-attempt-gate-test');
  readOnlyPool = createPool(readOnlyUrl(TEST_DATABASE_URL!), { max: 2 });
  readOnlyDb = createDb(readOnlyPool);
  holder.db = readOnlyDb;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await readOnlyPool.end();
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    ...GENERATION_FIXTURE_TABLES,
    'playlist_tracks',
    'playlists',
    'app_settings',
    'cover_images',
  ]);
  vi.stubEnv('IMAGE_PROVIDER', 'openrouter');
  vi.stubEnv('IMAGE_API_KEY', 'test-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.skipIf(skip).each(SUBJECTS)(
  'the cover attempt gate for a $kind',
  ({ kind, max, fullMessage }) => {
    it('opens when nothing would refuse, writing nothing', async () => {
      const ownerUserId = await createUser(testDb.db);
      const subject = await seedSubject(kind, ownerUserId);

      const verdict = await gate(ownerUserId, subject);

      expect(verdict.outcome).toBe('open');
      expect(await attemptCount()).toBe(0);
    });

    it('refuses without an image provider, telling the Admin where to set one up', async () => {
      vi.stubEnv('IMAGE_PROVIDER', '');
      const ownerUserId = await createUser(testDb.db);
      const subject = await seedSubject(kind, ownerUserId);

      expect(await gate(ownerUserId, subject)).toEqual({
        outcome: 'refused',
        reason: 'provider_unconfigured',
        message: 'No image provider is configured under Settings → Providers.',
      });
    });

    it('refuses a Member without an image provider, pointing at the Admin', async () => {
      vi.stubEnv('IMAGE_PROVIDER', '');
      const ownerUserId = await createUser(testDb.db);
      await testDb.db.insert(userProfiles).values({ userId: ownerUserId, role: 'member' });
      const subject = await seedSubject(kind, ownerUserId);

      expect(await gate(ownerUserId, subject)).toEqual({
        outcome: 'refused',
        reason: 'provider_unconfigured',
        message: 'No image provider is set up on this server. Ask the admin to add one.',
      });
    });

    it('refuses while Tailored Cover Art is switched off, worded for a Member', async () => {
      const ownerUserId = await createUser(testDb.db);
      await testDb.db.insert(userProfiles).values({ userId: ownerUserId, role: 'member' });
      const subject = await seedSubject(kind, ownerUserId);
      await updateUsageLimits(testDb.db, { tailoredCoverArtEnabled: false });

      expect(await gate(ownerUserId, subject)).toEqual({
        outcome: 'refused',
        reason: 'generation_disabled',
        message: 'Tailored Cover Art is turned off on this server. Ask the admin to turn it on.',
      });
    });

    it('answers a live attempt with its id rather than a refusal', async () => {
      const ownerUserId = await createUser(testDb.db);
      const subject = await seedSubject(kind, ownerUserId);
      const liveId = await seedLiveAttempt(ownerUserId, subject);

      expect(await gate(ownerUserId, subject)).toEqual({
        outcome: 'pending',
        coverGenerationId: liveId,
      });
      expect(await attemptCount()).toBe(1);
    });

    it('refuses once the cover history is full', async () => {
      const ownerUserId = await createUser(testDb.db);
      const subject = await seedSubject(kind, ownerUserId);
      await updateUsageLimits(testDb.db, {
        generatedCoversPerDay: 50,
        generatedCoversPerMonth: 200,
      });
      // Uploads take history slots exactly like generated covers.
      for (let i = 0; i < max - 2; i += 1) await seedReadyCover(ownerUserId, subject);
      await seedUploadedCover(ownerUserId, subject);
      await seedUploadedCover(ownerUserId, subject);

      const verdict = await gate(ownerUserId, subject);

      expect(verdict).toMatchObject({ outcome: 'refused', reason: 'history_full' });
      expect(verdict.outcome === 'refused' && verdict.message).toMatch(fullMessage);
      expect(verdict.outcome === 'refused' && verdict.message).toMatch(/Delete a previous cover/);
    });

    it('refuses once the cover budget is used up', async () => {
      const ownerUserId = await createUser(testDb.db);
      const subject = await seedSubject(kind, ownerUserId);
      await updateUsageLimits(testDb.db, { generatedCoversPerDay: 0 });

      expect(await gate(ownerUserId, subject)).toEqual({
        outcome: 'refused',
        reason: 'limit_reached',
        message: 'The cover generation limit is reached for this window.',
      });
    });

    it('refuses a disabled account with its own message, not as a used-up budget', async () => {
      const ownerUserId = await createUser(testDb.db);
      await testDb.db
        .insert(userProfiles)
        .values({ userId: ownerUserId, role: 'member', disabledAt: new Date() });
      const subject = await seedSubject(kind, ownerUserId);

      const verdict = await gate(ownerUserId, subject);

      expect(verdict).toMatchObject({ outcome: 'refused', reason: 'account_disabled' });
      expect(verdict.outcome === 'refused' && verdict.message).toMatch(/disabled/i);
    });
  },
);
