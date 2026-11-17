import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { randomUUID } from 'node:crypto';
import {
  coverImages,
  createPerson,
  createPlaylist,
  ensureOwnerPerson,
  insertGeneratedPlaylistCoverImage,
  insertPersonReferencePhoto,
  playlists,
  reservePlaylistCoverRegeneration,
  sessionCoverGenerations,
  updateCoverReferenceFrequency,
  updateSessionCoverGeneration,
  updateUsageLimits,
} from '@liedmotif/db';
import { COVER_STYLE_PRESETS, MAX_PLAYLIST_COVER_HISTORY } from '@liedmotif/shared';
import { multipartRequest } from '../helpers/multipart-request';

// Owner-scoped Playlist cover routes (the same machinery as
// Session Covers): reserving exactly one live attempt, pending on double-tap,
// cross-owner rejection, the sanitized status projection, and the free
// select/delete history operations against the mosaic default.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  enqueued: [] as Array<{ playlistId: string; ownerUserId: string; coverGenerationId: string }>,
  llm: null as null | {
    enhanceCoverDirection: (input: {
      text: string;
      context: Record<string, unknown>;
    }) => Promise<{ text: string; applied: boolean }>;
  },
  enhanceCalls: [] as Array<{ text: string; context: Record<string, unknown> }>,
  stored: new Map<string, Uint8Array>(),
  deletedKeys: [] as string[],
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers', () => ({
  getLlmProvider: async () => holder.llm,
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
  enqueueRegeneratePlaylistCover: async (
    _db: unknown,
    args: { playlistId: string; ownerUserId: string; coverGenerationId: string },
  ) => {
    holder.enqueued.push(args);
    return true;
  },
}));

const { POST: regeneratePost } = await import('@/app/api/playlists/cover/regenerate/route');
const { GET: statusGet } = await import('@/app/api/playlists/cover/status/route');
const { POST: selectPost } = await import('@/app/api/playlists/cover/select/route');
const { POST: deletePost } = await import('@/app/api/playlists/cover/delete/route');
const { POST: uploadPost } = await import('@/app/api/playlists/cover/upload/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const FIXTURE_TABLES = [
  ...GENERATION_FIXTURE_TABLES,
  'playlist_tracks',
  'playlists',
  'app_settings',
  'cover_images',
  'listener_profiles',
  'person_reference_photos',
  'people',
] as const;

/** The owner Person, carrying one reference photo. */
async function seedOwnerPersonWithPhoto(ownerUserId: string) {
  const person = await ensureOwnerPerson(testDb.db, ownerUserId);
  const id = randomUUID();
  const result = await insertPersonReferencePhoto(testDb.db, {
    id,
    ownerUserId,
    personId: person.id,
    storageProvider: 'local-fs',
    storageKey: `people/${ownerUserId}/${person.id}/${id}.webp`,
    mediaType: 'image/webp',
    byteSize: 4,
  });
  expect(result.inserted).toBe(true);
  return person;
}

/** A settled, servable generated attempt (ledger row + cover_images row). */
async function seedReadyAttempt(
  ownerUserId: string,
  playlistId: string,
  opts: { createdAt?: Date } = {},
) {
  const id = randomUUID();
  const coverImageId = randomUUID();
  const storageKey = `covers/generated-playlists/${ownerUserId}/${playlistId}/${coverImageId}.webp`;
  const reserved = await reservePlaylistCoverRegeneration(testDb.db, {
    id,
    ownerUserId,
    playlistId,
    coverImageId,
    storageKey,
    coverStyle: 'minimal',
  });
  expect(reserved).not.toBeNull();
  await testDb.db
    .update(sessionCoverGenerations)
    .set({
      state: 'ready',
      settledAt: new Date(),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .where(eq(sessionCoverGenerations.id, id));
  await insertGeneratedPlaylistCoverImage(testDb.db, {
    id: coverImageId,
    ownerUserId,
    playlistId,
    storageProvider: 'local-fs',
    storageKey,
    byteSize: 1,
    label: 'Playlist route fixture cover',
    model: 'test-model',
    visualTheme: 'minimal',
  });
  if (opts.createdAt) {
    await testDb.db
      .update(coverImages)
      .set({ createdAt: opts.createdAt })
      .where(eq(coverImages.id, coverImageId));
  }
  return { id, coverImageId };
}

async function seedUploadedCover(ownerUserId: string, playlistId: string) {
  const coverImageId = randomUUID();
  await testDb.db.insert(coverImages).values({
    id: coverImageId,
    sourceType: 'uploaded',
    storageProvider: 'local-fs',
    storageKey: `covers/uploaded/${ownerUserId}/${coverImageId}.webp`,
    tags: { label: 'Uploaded playlist cover' },
    provenance: { ownerUserId, playlistId },
  });
  return { coverImageId };
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

function getStatus(playlistId: string) {
  return statusGet(
    new Request(`http://localhost/api/playlists/cover/status?playlistId=${playlistId}`),
  );
}

async function playlistCoverId(playlistId: string): Promise<string | null> {
  const [row] = await testDb.db
    .select({ coverImageId: playlists.coverImageId })
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  return row!.coverImageId;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('playlist-cover-routes-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, FIXTURE_TABLES);
  holder.ownerUserId = null;
  holder.enqueued = [];
  holder.llm = null;
  holder.enhanceCalls = [];
  holder.stored.clear();
  holder.deletedKeys = [];
  // A usable image provider unless a test opts out (the route's provider gate).
  vi.stubEnv('IMAGE_PROVIDER', 'openrouter');
  vi.stubEnv('IMAGE_API_KEY', 'test-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedOwnedPlaylist(name = 'Focus Nights') {
  const ownerUserId = await createUser(testDb.db);
  const playlist = await createPlaylist(testDb.db, { ownerUserId, name });
  holder.ownerUserId = ownerUserId;
  return { ownerUserId, playlistId: playlist.id };
}

describe.skipIf(skip)('POST /api/playlists/cover/regenerate', () => {
  it('reserves one attempt with the frozen style pick and enqueues its per-attempt job', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();

    const response = await postJson(regeneratePost, {
      playlistId,
      coverStyle: 'drawing',
      guidance: 'warm dusk light over a paper skyline',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { outcome: string; coverGenerationId: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.outcome).toBe('started');

    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.playlistId, playlistId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.data.coverGenerationId,
      state: 'reserved',
      trigger: 'user_regenerate',
      possiblyPaid: false,
      activitySessionId: null,
    });
    // The style pick and guidance are frozen into the attempt — a Playlist
    // persists no style of its own.
    expect(rows[0]!.plan.selectedStyle).toBe('drawing');
    expect(rows[0]!.plan.userGuidance).toBe('warm dusk light over a paper skyline');
    expect(holder.enqueued).toEqual([
      { playlistId, ownerUserId, coverGenerationId: body.data.coverGenerationId },
    ]);
  });

  // A Playlist has no prompt for Auto to pick a style from (ADR 0007): no style
  // means Random, rolled now so the attempt freezes a concrete preset.
  it('a Playlist cover with no style resolves Random to a concrete style', async () => {
    const { playlistId } = await seedOwnedPlaylist();

    const body = (await (await postJson(regeneratePost, { playlistId })).json()) as {
      data: { outcome: string; coverGenerationId: string };
    };
    expect(body.data.outcome).toBe('started');

    const [attempt] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
    expect(COVER_STYLE_PRESETS).toContain(attempt?.plan.selectedStyle);
  });

  it('a Playlist cover asking for Auto is refused', async () => {
    const { playlistId } = await seedOwnedPlaylist();

    const auto = await postJson(regeneratePost, { playlistId, coverStyle: 'auto' });
    const unknown = await postJson(regeneratePost, { playlistId, coverStyle: 'watercolor' });
    expect(auto.status).toBe(400);
    const message = ((await auto.json()) as { error: { message: string } }).error.message;
    expect(message).toBe(((await unknown.json()) as { error: { message: string } }).error.message);

    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.playlistId, playlistId));
    expect(rows).toHaveLength(0);
    expect(holder.enqueued).toHaveLength(0);
  });

  it('returns the live attempt as pending on a double-tap instead of spending again', async () => {
    const { playlistId } = await seedOwnedPlaylist();

    const first = (await (await postJson(regeneratePost, { playlistId })).json()) as {
      data: { coverGenerationId: string };
    };
    const second = await postJson(regeneratePost, { playlistId });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { data: { outcome: string; coverGenerationId: string } };
    expect(body.data.outcome).toBe('pending');
    expect(body.data.coverGenerationId).toBe(first.data.coverGenerationId);

    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.playlistId, playlistId));
    expect(rows).toHaveLength(1);
    expect(holder.enqueued).toHaveLength(1);
  });

  it('rejects a foreign playlist without creating an attempt', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherOwnerUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, {
      ownerUserId: otherOwnerUserId,
      name: 'Not yours',
    });
    holder.ownerUserId = ownerUserId;

    const response = await postJson(regeneratePost, { playlistId: playlist.id });
    expect(response.status).toBe(404);
    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.playlistId, playlist.id));
    expect(rows).toHaveLength(0);
    expect(holder.enqueued).toHaveLength(0);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await postJson(regeneratePost, {
      playlistId: '00000000-0000-4000-8000-000000000000',
    });
    expect(response.status).toBe(401);
  });

  it('freezes an explicit People-reference request onto the reserved attempt', async () => {
    const { playlistId } = await seedOwnedPlaylist();

    const body = (await (
      await postJson(regeneratePost, { playlistId, usePeopleReferences: true })
    ).json()) as { data: { coverGenerationId: string } };

    const [attempt] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
    expect(attempt?.plan.usePeopleReferences).toBe(true);
  });

  it.each([
    ['omitted', {}],
    ['off', { usePeopleReferences: false }],
  ])('reserves a prompt-only attempt when the People request is %s', async (_case, extra) => {
    const { playlistId } = await seedOwnedPlaylist();

    const body = (await (await postJson(regeneratePost, { playlistId, ...extra })).json()) as {
      data: { coverGenerationId: string };
    };

    const [attempt] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
    expect(attempt?.plan.usePeopleReferences).toBeFalsy();
  });

  it('rejects unknown request fields', async () => {
    const { playlistId } = await seedOwnedPlaylist();

    const response = await postJson(regeneratePost, { playlistId, usePeoplePhotos: true });
    expect(response.status).toBe(400);
    expect(holder.enqueued).toHaveLength(0);
  });

  it('enhances the guidance at the web boundary with playlist-derived context', async () => {
    holder.llm = {
      enhanceCoverDirection: async (input) => {
        holder.enhanceCalls.push(input);
        return { text: `ENHANCED ${input.text}`, applied: true };
      },
    };
    const { playlistId } = await seedOwnedPlaylist('Rainy Evenings');

    const response = await postJson(regeneratePost, {
      playlistId,
      coverStyle: 'minimal',
      guidance: 'warm dusk skyline',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { coverGenerationId: string } };
    const [attempt] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, body.data.coverGenerationId));
    expect(attempt?.plan.userGuidance).toBe('warm dusk skyline');
    expect(attempt?.plan.effectiveGuidance).toBe('ENHANCED warm dusk skyline');
    expect(attempt?.plan.enhancementApplied).toBe(true);

    // The context carries only safe playlist facts — the name and member genres.
    expect(holder.enhanceCalls).toHaveLength(1);
    expect(holder.enhanceCalls[0]!.context).toEqual({
      sessionName: 'Rainy Evenings',
      style: 'minimal',
      mood: null,
      genres: [],
      imageModel: expect.any(String),
    });
  });

  it('refuses at the cover limit without reserving or spending', async () => {
    const { playlistId } = await seedOwnedPlaylist();
    await updateUsageLimits(testDb.db, { generatedCoversPerDay: 0 });

    const response = await postJson(regeneratePost, { playlistId });
    expect(response.status).toBe(429);
    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.playlistId, playlistId));
    expect(rows).toHaveLength(0);
    expect(holder.enqueued).toHaveLength(0);
  });

  it('refuses a guided regeneration over budget without burning the paid LLM call', async () => {
    // The lock-free precheck must refuse before enhanceCoverText so a
    // budget-exhausted tap spends no unmetered LLM call.
    holder.llm = {
      enhanceCoverDirection: async (input) => {
        holder.enhanceCalls.push(input);
        return { text: `ENHANCED ${input.text}`, applied: true };
      },
    };
    const { playlistId } = await seedOwnedPlaylist();
    await updateUsageLimits(testDb.db, { generatedCoversPerDay: 0 });

    const response = await postJson(regeneratePost, {
      playlistId,
      guidance: 'warm dusk skyline',
    });
    expect(response.status).toBe(429);
    expect(holder.enhanceCalls).toHaveLength(0);
    const rows = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.playlistId, playlistId));
    expect(rows).toHaveLength(0);
    expect(holder.enqueued).toHaveLength(0);
  });

  it('refuses a new attempt while the playlist holds the maximum of 10 covers', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    await updateUsageLimits(testDb.db, { generatedCoversPerDay: 50, generatedCoversPerMonth: 200 });
    for (let i = 0; i < MAX_PLAYLIST_COVER_HISTORY; i += 1) {
      await seedReadyAttempt(ownerUserId, playlistId);
    }

    const response = await postJson(regeneratePost, { playlistId });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { ok: boolean; error: { message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/delete/i);
    expect(holder.enqueued).toHaveLength(0);

    // Deleting one cover frees the slot again.
    const statusBody = (await (await getStatus(playlistId)).json()) as {
      data: { history: Array<{ coverImageId: string; isCurrent: boolean }> };
    };
    const deletable = statusBody.data.history.find((entry) => !entry.isCurrent)!;
    await postJson(deletePost, { playlistId, coverImageId: deletable.coverImageId });
    const retry = await postJson(regeneratePost, { playlistId });
    expect(retry.status).toBe(200);
  });

  it('refuses when cover generation is disabled', async () => {
    const { playlistId } = await seedOwnedPlaylist();
    await updateUsageLimits(testDb.db, { tailoredCoverArtEnabled: false });

    const response = await postJson(regeneratePost, { playlistId });
    expect(response.status).toBe(409);
    expect(holder.enqueued).toHaveLength(0);
  });

  it('refuses when no image provider is configured', async () => {
    vi.stubEnv('IMAGE_PROVIDER', '');
    const { playlistId } = await seedOwnedPlaylist();

    const response = await postJson(regeneratePost, { playlistId });
    expect(response.status).toBe(409);
    expect(holder.enqueued).toHaveLength(0);
  });
});

describe.skipIf(skip)('GET /api/playlists/cover/status', () => {
  it('reports a live regeneration as generating with the usage the worker counts', async () => {
    const { playlistId } = await seedOwnedPlaylist();
    await updateUsageLimits(testDb.db, { generatedCoversPerDay: 5, generatedCoversPerMonth: 30 });
    const started = (await (await postJson(regeneratePost, { playlistId })).json()) as {
      data: { coverGenerationId: string };
    };

    const response = await getStatus(playlistId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        coverImageId: string | null;
        generating: boolean;
        latestRegeneration: { coverGenerationId: string; status: string } | null;
        usage: Record<string, unknown>;
      };
    };
    expect(body.data.coverImageId).toBeNull();
    expect(body.data.generating).toBe(true);
    expect(body.data.latestRegeneration).toMatchObject({
      coverGenerationId: started.data.coverGenerationId,
      status: 'generating',
      failureMessageSafe: null,
    });
    // The live reservation counts as possibly-paid usage immediately; the
    // Suno fallback never applies to prompt-driven playlist covers.
    expect(body.data.usage).toMatchObject({
      usedDay: 1,
      limitDay: 5,
      remaining: 4,
      enabled: true,
      providerConfigured: true,
      sunoFallbackActive: false,
    });
  });

  it('reports a settled failure with sanitized plain-language copy', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    const started = (await (await postJson(regeneratePost, { playlistId })).json()) as {
      data: { coverGenerationId: string };
    };
    await updateSessionCoverGeneration(testDb.db, {
      ownerUserId,
      id: started.data.coverGenerationId,
      state: 'provider_unavailable',
      failureCategory: 'provider_unavailable',
      settledAt: new Date(),
    });

    const body = (await (await getStatus(playlistId)).json()) as {
      data: {
        generating: boolean;
        latestRegeneration: { status: string; failureMessageSafe: string };
      };
    };
    expect(body.data.generating).toBe(false);
    expect(body.data.latestRegeneration.status).toBe('failed');
    expect(body.data.latestRegeneration.failureMessageSafe).toMatch(/unavailable/i);
  });

  it('rejects a foreign playlist', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherOwnerUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, {
      ownerUserId: otherOwnerUserId,
      name: 'Not yours',
    });
    holder.ownerUserId = ownerUserId;
    const response = await getStatus(playlist.id);
    expect(response.status).toBe(404);
  });

  async function peopleReferencesAvailable(playlistId: string): Promise<boolean> {
    const body = (await (await getStatus(playlistId)).json()) as {
      data: { peopleReferencesAvailable: boolean };
    };
    return body.data.peopleReferencesAvailable;
  }

  it('offers People references only with a photo on file and the frequency allowing it', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    expect(await peopleReferencesAvailable(playlistId)).toBe(false);

    // A Person without a reference photo still cannot render anyone.
    await createPerson(testDb.db, { ownerUserId, name: 'Julia' });
    expect(await peopleReferencesAvailable(playlistId)).toBe(false);

    await seedOwnerPersonWithPhoto(ownerUserId);
    expect(await peopleReferencesAvailable(playlistId)).toBe(true);

    // `never` is the hard opt-out: the option stops being offered at all.
    await updateCoverReferenceFrequency(testDb.db, ownerUserId, 'never');
    expect(await peopleReferencesAvailable(playlistId)).toBe(false);
  });

  it('answers availability from the requesting owner’s own People roster', async () => {
    const { playlistId } = await seedOwnedPlaylist();
    const otherOwnerUserId = await createUser(testDb.db);
    await seedOwnerPersonWithPhoto(otherOwnerUserId);

    expect(await peopleReferencesAvailable(playlistId)).toBe(false);
  });

  it('lists generated and uploaded covers newest first with the current one marked', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    const older = await seedReadyAttempt(ownerUserId, playlistId, {
      createdAt: new Date('2026-07-18T10:00:00Z'),
    });
    const newer = await seedReadyAttempt(ownerUserId, playlistId, {
      createdAt: new Date('2026-07-20T10:00:00Z'),
    });
    const uploaded = await seedUploadedCover(ownerUserId, playlistId);
    await testDb.db
      .update(coverImages)
      .set({ createdAt: new Date('2026-07-19T10:00:00Z') })
      .where(eq(coverImages.id, uploaded.coverImageId));
    await testDb.db
      .update(playlists)
      .set({ coverImageId: uploaded.coverImageId })
      .where(eq(playlists.id, playlistId));

    const body = (await (await getStatus(playlistId)).json()) as {
      data: {
        coverImageId: string;
        history: Array<{ coverImageId: string; isCurrent: boolean; style: string }>;
      };
    };
    expect(body.data.coverImageId).toBe(uploaded.coverImageId);
    expect(body.data.history.map((entry) => entry.coverImageId)).toEqual([
      newer.coverImageId,
      uploaded.coverImageId,
      older.coverImageId,
    ]);
    expect(body.data.history[0]).toMatchObject({ isCurrent: false, style: 'minimal' });
    expect(body.data.history[1]).toMatchObject({ isCurrent: true, style: 'uploaded' });
  });
});

describe.skipIf(skip)('POST /api/playlists/cover/select', () => {
  it('re-points the playlist to a history cover for free and clears back to the mosaic', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    const attempt = await seedReadyAttempt(ownerUserId, playlistId);

    const response = await postJson(selectPost, { playlistId, coverImageId: attempt.coverImageId });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { coverImageId: string } }).data.coverImageId).toBe(
      attempt.coverImageId,
    );
    expect(await playlistCoverId(playlistId)).toBe(attempt.coverImageId);
    // Zero cost: no jobs were enqueued for the pointer swap.
    expect(holder.enqueued).toHaveLength(0);

    const cleared = await postJson(selectPost, { playlistId, coverImageId: null });
    expect(cleared.status).toBe(200);
    expect(await playlistCoverId(playlistId)).toBeNull();
  });

  it('adopts the playlist uploaded cover from the history', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    const uploaded = await seedUploadedCover(ownerUserId, playlistId);

    const response = await postJson(selectPost, {
      playlistId,
      coverImageId: uploaded.coverImageId,
    });
    expect(response.status).toBe(200);
    expect(await playlistCoverId(playlistId)).toBe(uploaded.coverImageId);
  });

  it('rejects covers outside this playlist cover history', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    const otherPlaylist = await createPlaylist(testDb.db, { ownerUserId, name: 'Other' });
    const foreign = await seedReadyAttempt(ownerUserId, otherPlaylist.id);

    const response = await postJson(selectPost, { playlistId, coverImageId: foreign.coverImageId });
    expect(response.status).toBe(404);
    expect(await playlistCoverId(playlistId)).toBeNull();
  });

  it('rejects a foreign owner playlist', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherOwnerUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, {
      ownerUserId: otherOwnerUserId,
      name: 'Not yours',
    });
    const attempt = await seedReadyAttempt(otherOwnerUserId, playlist.id);
    holder.ownerUserId = ownerUserId;

    const response = await postJson(selectPost, {
      playlistId: playlist.id,
      coverImageId: attempt.coverImageId,
    });
    expect(response.status).toBe(404);
  });
});

describe.skipIf(skip)('POST /api/playlists/cover/delete', () => {
  it('deletes a non-current history cover and queues its bytes for reclamation', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    const older = await seedReadyAttempt(ownerUserId, playlistId, {
      createdAt: new Date('2026-07-18T10:00:00Z'),
    });
    const newer = await seedReadyAttempt(ownerUserId, playlistId, {
      createdAt: new Date('2026-07-19T10:00:00Z'),
    });
    await testDb.db
      .update(playlists)
      .set({ coverImageId: newer.coverImageId })
      .where(eq(playlists.id, playlistId));

    const response = await postJson(deletePost, { playlistId, coverImageId: older.coverImageId });
    expect(response.status).toBe(200);

    const statusBody = (await (await getStatus(playlistId)).json()) as {
      data: { history: Array<{ coverImageId: string }> };
    };
    expect(statusBody.data.history.map((entry) => entry.coverImageId)).toEqual([
      newer.coverImageId,
    ]);
    const queued = await testDb.pool.query(
      'select reason from deletion_queue_items where owner_user_id = $1',
      [ownerUserId],
    );
    // The original and its cached tile rendition.
    expect(queued.rows).toEqual([
      { reason: 'playlist_cover_history_deleted' },
      { reason: 'playlist_cover_history_deleted' },
    ]);
    // Spend accounting survives: the ledger row is untouched.
    const [ledger] = await testDb.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, older.id));
    expect(ledger?.state).toBe('ready');
  });

  it('refuses to delete the current cover', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    const current = await seedReadyAttempt(ownerUserId, playlistId);
    await testDb.db
      .update(playlists)
      .set({ coverImageId: current.coverImageId })
      .where(eq(playlists.id, playlistId));

    const response = await postJson(deletePost, { playlistId, coverImageId: current.coverImageId });
    expect(response.status).toBe(409);
  });

  it('rejects covers outside this playlist history and foreign owners', async () => {
    const { playlistId } = await seedOwnedPlaylist();
    const otherOwnerUserId = await createUser(testDb.db);
    const foreignPlaylist = await createPlaylist(testDb.db, {
      ownerUserId: otherOwnerUserId,
      name: 'Foreign',
    });
    const foreign = await seedReadyAttempt(otherOwnerUserId, foreignPlaylist.id);

    const crossHistory = await postJson(deletePost, {
      playlistId,
      coverImageId: foreign.coverImageId,
    });
    expect(crossHistory.status).toBe(404);
    const crossOwner = await postJson(deletePost, {
      playlistId: foreignPlaylist.id,
      coverImageId: foreign.coverImageId,
    });
    expect(crossOwner.status).toBe(404);
  });
});

describe.skipIf(skip)('POST /api/playlists/cover/upload', () => {
  /** A solid-color JPEG — every pixel known, so a composited badge would show. */
  async function makeJpeg(width: number, height: number): Promise<Buffer> {
    return sharp({
      create: { width, height, channels: 3, background: { r: 20, g: 120, b: 220 } },
    })
      .jpeg()
      .toBuffer();
  }

  async function upload(playlistId: string | null, file: File | null): Promise<Response> {
    const form = new FormData();
    if (playlistId) form.set('playlistId', playlistId);
    if (file) form.set('file', file);
    return uploadPost(multipartRequest('http://localhost/api/playlists/cover/upload', form));
  }

  async function uploadImage(playlistId: string): Promise<Response> {
    const jpeg = await makeJpeg(1500, 900);
    return upload(playlistId, new File([new Uint8Array(jpeg)], 'art.jpg', { type: 'image/jpeg' }));
  }

  it('stores an unbadged square WebP and applies it as the playlist cover', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();

    const response = await uploadImage(playlistId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { coverImageId: string } };
    const { coverImageId } = body.data;
    expect(await playlistCoverId(playlistId)).toBe(coverImageId);

    const [key, bytes] = [...holder.stored.entries()][0]!;
    expect(key).toBe(`covers/uploaded/${ownerUserId}/${coverImageId}.webp`);
    const metadata = await sharp(Buffer.from(bytes)).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 1024, height: 1024 });
    // A Playlist cover wears no badge: the bottom-left is still the source
    // color, give or take what the lossy re-encode shifts.
    const { data } = await sharp(Buffer.from(bytes))
      .extract({ left: 110, top: 830, width: 220, height: 80 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (const [channel, expected] of [20, 120, 220].entries()) {
      expect(Math.abs(data[channel]! - expected)).toBeLessThan(4);
    }
  });

  it('retires a replaced upload and keeps generated history re-selectable', async () => {
    const { playlistId } = await seedOwnedPlaylist();
    const generated = await seedReadyAttempt(holder.ownerUserId!, playlistId);
    const first = (await (await uploadImage(playlistId)).json()) as {
      data: { coverImageId: string };
    };
    const second = (await (await uploadImage(playlistId)).json()) as {
      data: { coverImageId: string };
    };

    expect(await playlistCoverId(playlistId)).toBe(second.data.coverImageId);
    const remaining = await testDb.db.select({ id: coverImages.id }).from(coverImages);
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [generated.coverImageId, second.data.coverImageId].sort(),
    );
    expect(first.data.coverImageId).not.toBe(second.data.coverImageId);
  });

  it('rejects bytes whose decoded format is not the declared one', async () => {
    const { playlistId } = await seedOwnedPlaylist();
    // The declared `Content-Type` is a client label; these bytes decode as SVG,
    // which no upload surface accepts.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>',
    );
    const response = await upload(
      playlistId,
      new File([new Uint8Array(svg)], 'art.png', { type: 'image/png' }),
    );
    expect(response.status).toBe(400);
    expect(holder.stored.size).toBe(0);
  });

  it('rejects a non-uuid playlistId without decoding the image', async () => {
    await seedOwnedPlaylist();
    const response = await uploadImage('not-a-uuid');
    expect(response.status).toBe(400);
    expect(holder.stored.size).toBe(0);
  });

  it('rejects a wrong type, an oversized file, and a missing playlist', async () => {
    const { playlistId } = await seedOwnedPlaylist();
    expect(
      (await upload(playlistId, new File([new Uint8Array(3)], 'n.txt', { type: 'text/plain' })))
        .status,
    ).toBe(400);
    // Oversized bodies are refused by the declared-size precheck, before the
    // multipart parse buffers them.
    const huge = new File([new Uint8Array(11 * 1024 * 1024)], 'big.jpg', { type: 'image/jpeg' });
    expect((await upload(playlistId, huge)).status).toBe(413);
    expect((await upload(null, null)).status).toBe(400);
    expect(holder.stored.size).toBe(0);

    // A playlist that is not the owner's compensates the just-written bytes.
    const foreignOwner = await createUser(testDb.db);
    const foreign = await createPlaylist(testDb.db, {
      ownerUserId: foreignOwner,
      name: 'Foreign',
    });
    expect((await uploadImage(foreign.id)).status).toBe(404);
    expect(holder.stored.size).toBe(0);
    expect(holder.deletedKeys).toHaveLength(1);
  });
});
