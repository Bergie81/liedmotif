import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
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
  activitySessions,
  coverImages,
  deletionQueueItems,
  getStorageUsage,
  refreshStorageUsage,
  reserveSessionCoverRegeneration,
  updateUsageLimits,
  userProfiles,
} from '@liedmotif/db';
import { MAX_SESSION_COVER_HISTORY } from '@liedmotif/shared';
import { multipartRequest } from '../helpers/multipart-request';

// Owner-uploaded Session covers: the upload joins the session's cover history
// as a previewed candidate — it never re-points the session by itself, never
// spends, and occupies one of the history slots.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  stored: new Map<string, Uint8Array>(),
  deletedKeys: [] as string[],
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/providers')>()),
  getLlmProvider: async () => null,
  getStorageProvider: () => ({
    providerKey: 'local-fs',
    write: async (input: { key: string; body: Uint8Array }) => {
      holder.stored.set(input.key, input.body);
      return { key: input.key, byteSize: input.body.length, updatedAt: new Date() };
    },
    delete: async (key: string) => {
      holder.deletedKeys.push(key);
      holder.stored.delete(key);
    },
  }),
}));
vi.mock('@/lib/worker-jobs', () => ({
  enqueueEmbedTrackMetadataBatch: async () => undefined,
}));

const { POST: uploadPost } = await import('@/app/api/sessions/cover/upload/route');
const { POST: statusPost } = await import('@/app/api/sessions/cover/status/route');
const { POST: selectPost } = await import('@/app/api/sessions/cover/select/route');
const { POST: deletePost } = await import('@/app/api/sessions/cover/delete/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/** A solid-color JPEG — every pixel known, so a composited badge is visible. */
async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 220 } },
  })
    .jpeg()
    .toBuffer();
}

async function uploadFile(
  sessionId: string | null,
  file: File | null,
): Promise<{ response: Response; body: { ok: boolean; data?: { coverImageId: string } } }> {
  const form = new FormData();
  if (sessionId) form.set('activitySessionId', sessionId);
  if (file) form.set('file', file);
  const response = await uploadPost(
    multipartRequest('http://localhost/api/sessions/cover/upload', form),
  );
  return { response, body: (await response.clone().json()) as { ok: boolean } };
}

async function uploadImage(sessionId: string, size = 1400) {
  const jpeg = await makeJpeg(size, size);
  return uploadFile(sessionId, new File([new Uint8Array(jpeg)], 'art.jpg', { type: 'image/jpeg' }));
}

function postJson(handler: (r: Request) => Promise<Response>, body: unknown) {
  return handler(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Mean per-channel value of one region of the stored cover. */
async function regionMean(
  bytes: Uint8Array,
  region: { left: number; top: number; width: number; height: number },
): Promise<number> {
  const { data } = await sharp(Buffer.from(bytes))
    .extract(region)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data.reduce((total, value) => total + value, 0) / data.length;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('session-cover-upload-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings', 'cover_images']);
  holder.ownerUserId = null;
  holder.stored.clear();
  holder.deletedKeys = [];
});

describe.skipIf(skip)('POST /api/sessions/cover/upload', () => {
  it('stores a clean 1024² WebP and leaves the Session wearing its old cover', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;

    const { response, body } = await uploadImage(sessionId);
    expect(response.status).toBe(200);
    const coverImageId = body.data!.coverImageId;

    const [key, bytes] = [...holder.stored.entries()][0]!;
    expect(key).toBe(`covers/uploaded/${ownerUserId}/${coverImageId}.webp`);
    const metadata = await sharp(Buffer.from(bytes)).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 1024, height: 1024 });
    // Stored covers are clean — the badge exists only in embedded album art —
    // so the corner the badge occupies there matches the far corner here.
    const badgeRegion = await regionMean(bytes, { left: 110, top: 830, width: 220, height: 80 });
    const farRegion = await regionMean(bytes, { left: 700, top: 100, width: 200, height: 200 });
    expect(Math.abs(badgeRegion - farRegion)).toBeLessThan(2);

    const [row] = await testDb.db
      .select()
      .from(coverImages)
      .where(eq(coverImages.id, coverImageId));
    // `branded: false` — the embed-time rendition composites the badge for it.
    expect(row).toMatchObject({ sourceType: 'uploaded', storageKey: key, branded: false });
    expect(row!.provenance).toMatchObject({ ownerUserId, activitySessionId: sessionId });

    // Nothing is applied on its own — the owner previews and saves the swap.
    const [session] = await testDb.db
      .select({ coverImageId: activitySessions.coverImageId })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(session!.coverImageId).not.toBe(coverImageId);
  });

  it('lists the upload in the cover history, adopts it on select, and deletes it again', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    const { body } = await uploadImage(sessionId);
    const coverImageId = body.data!.coverImageId;

    const status = (await (
      await postJson(statusPost, { activitySessionId: sessionId })
    ).json()) as { data: { history: Array<{ coverImageId: string; style: string }> } };
    expect(status.data.history).toEqual([
      expect.objectContaining({ coverImageId, style: 'uploaded', isCurrent: false }),
    ]);

    expect(
      (await postJson(selectPost, { activitySessionId: sessionId, coverImageId })).status,
    ).toBe(200);
    const [applied] = await testDb.db
      .select({ coverImageId: activitySessions.coverImageId })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(applied!.coverImageId).toBe(coverImageId);

    // The CURRENT cover is never deletable — the pointer must stay servable.
    expect(
      (await postJson(deletePost, { activitySessionId: sessionId, coverImageId })).status,
    ).toBe(409);
    await testDb.db
      .update(activitySessions)
      .set({ coverImageId: null })
      .where(eq(activitySessions.id, sessionId));
    expect(
      (await postJson(deletePost, { activitySessionId: sessionId, coverImageId })).status,
    ).toBe(200);
    expect(
      await testDb.db.select().from(coverImages).where(eq(coverImages.id, coverImageId)),
    ).toEqual([]);
    const queued = await testDb.db.select().from(deletionQueueItems);
    // The original and its cached tile rendition.
    expect(queued).toHaveLength(2);
  });

  it('refuses an upload once the Session holds the maximum number of covers', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    for (let i = 0; i < MAX_SESSION_COVER_HISTORY; i += 1) {
      expect((await uploadImage(sessionId, 400)).response.status).toBe(200);
    }
    holder.deletedKeys = [];

    const { response, body } = await uploadImage(sessionId, 400);
    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: { message: expect.stringContaining('Delete a previous') },
    });
    // Refused before any work: no bytes written, so none to compensate either.
    expect(holder.deletedKeys).toEqual([]);
    expect(holder.stored.size).toBe(MAX_SESSION_COVER_HISTORY);
  });

  it('counts an in-flight generation against the cap, so the tenth slot is not sold twice', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    for (let i = 0; i < MAX_SESSION_COVER_HISTORY - 1; i += 1) {
      expect((await uploadImage(sessionId, 400)).response.status).toBe(200);
    }
    // The last free slot is claimed by a reserved attempt that has not settled.
    const reserved = await reserveSessionCoverRegeneration(testDb.db, {
      id: randomUUID(),
      ownerUserId,
      activitySessionId: sessionId,
      coverImageId: randomUUID(),
      storageKey: `covers/generated/${ownerUserId}/${sessionId}/live.webp`,
    });
    expect(reserved).not.toBeNull();

    expect((await uploadImage(sessionId, 400)).response.status).toBe(429);
    expect(holder.stored.size).toBe(MAX_SESSION_COVER_HISTORY - 1);
  });

  it('rejects a wrong type, undecodable bytes, and a missing Session', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;

    const wrongType = await uploadFile(
      sessionId,
      new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' }),
    );
    expect(wrongType.response.status).toBe(400);
    const undecodable = await uploadFile(
      sessionId,
      new File([new Uint8Array([1, 2, 3])], 'fake.png', { type: 'image/png' }),
    );
    expect(undecodable.response.status).toBe(400);
    const noSession = await uploadImage(randomUUID());
    expect(noSession.response.status).toBe(404);
    expect(holder.stored.size).toBe(0);
    expect(await testDb.db.select().from(coverImages)).toEqual([]);
  });

  it('refuses the upload once measured storage has reached the configured quota', async () => {
    // The gate lives in the shared upload intake, so this case also stands for
    // the avatar, Person photo, and Playlist cover routes. A Member is told who
    // can fix it, never pointed at an admin-only setting.
    const ownerUserId = await createUser(testDb.db);
    await testDb.db.insert(userProfiles).values({ userId: ownerUserId, role: 'member' });
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    // A zero quota is "store nothing more", the same reading a zero generation
    // cap has; the measured total is the real cached one.
    await updateUsageLimits(testDb.db, { storageQuotaBytes: 0 });
    await refreshStorageUsage(testDb.db);

    const { response } = await uploadImage(sessionId);
    expect(response.status).toBe(429);
    const { error } = (await response.clone().json()) as { error: { message: string } };
    expect(error.message).toContain('The Admin needs to free space or raise the quota.');
    expect(error.message).not.toContain('Settings');
    expect(holder.stored.size).toBe(0);
    expect(await testDb.db.select().from(coverImages)).toEqual([]);
  });

  it('grows the accounted storage total by what the cover actually stored', async () => {
    // Both halves of the accounting have to agree: the running figure the next
    // admission reads, and the fresh measurement that replaces it.
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = ownerUserId;
    // Deltas, not absolutes: the measured total sums the whole database, and
    // this suite truncates only the tables its own fixtures touch.
    const { totalBytes: before } = await refreshStorageUsage(testDb.db);

    const { response, body } = await uploadImage(sessionId);
    expect(response.status).toBe(200);

    const [stored] = await testDb.db
      .select({ byteSize: coverImages.byteSize })
      .from(coverImages)
      .where(eq(coverImages.id, body.data!.coverImageId));
    const written = holder.stored.values().next().value!.byteLength;
    expect(stored?.byteSize).toBe(written);
    expect((await getStorageUsage(testDb.db))?.totalBytes).toBe(before + written);
    expect((await refreshStorageUsage(testDb.db)).totalBytes).toBe(before + written);
  });

  it('requires admin sign-in', async () => {
    const ownerUserId = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId });
    holder.ownerUserId = null;
    expect((await uploadImage(sessionId)).response.status).toBe(401);
    expect(holder.stored.size).toBe(0);
  });
});
