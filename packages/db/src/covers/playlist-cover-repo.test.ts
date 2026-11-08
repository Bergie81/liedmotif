import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { coverImages, playlists, playlistTracks, sessionCoverGenerations } from '../schema';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { createPlaylist, deletePlaylist } from '../playlists/playlists-repo';
import { coverRenditionKey } from './cover-reclaim';
import {
  countReservedOrPossiblyPaidCovers,
  planSessionCoverGeneration,
} from './generation-ledger-repo';
import {
  deletePlaylistCoverFromHistory,
  getLivePlaylistCoverGeneration,
  getPlaylistCoverHistoryEntry,
  getPlaylistCoverSubject,
  insertGeneratedPlaylistCoverImage,
  listPlaylistCoverHistory,
  listUploadedPlaylistCovers,
  reservePlaylistCoverRegeneration,
  setPlaylistCoverImage,
} from './playlist-cover-repo';
import { ownerScope, POOL_SCOPE } from '../member-pool';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURE_TABLES = [
  ...GENERATION_FIXTURE_TABLES,
  'playlist_tracks',
  'playlists',
  'cover_images',
] as const;

describeIfDb('Playlist cover ledger', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-playlist-cover-ledger-test');
  }, 60_000);

  afterAll(async () => ctx?.pool.end());

  beforeEach(async () => truncateTables(ctx.pool, FIXTURE_TABLES));

  async function seedPlaylist(ownerUserId: string, name = 'Focus Nights') {
    const playlist = await createPlaylist(ctx.db, { ownerUserId, name });
    return playlist.id;
  }

  function reserveInput(ownerUserId: string, playlistId: string) {
    const id = randomUUID();
    const coverImageId = randomUUID();
    return {
      id,
      ownerUserId,
      playlistId,
      coverImageId,
      storageKey: `covers/generated-playlists/${ownerUserId}/${playlistId}/${coverImageId}.webp`,
      coverStyle: 'minimal',
    };
  }

  /** A settled, servable generated attempt (ledger row + cover_images row). */
  async function seedReadyAttempt(
    ownerUserId: string,
    playlistId: string,
    opts: { createdAt?: Date } = {},
  ) {
    const input = reserveInput(ownerUserId, playlistId);
    const reserved = await reservePlaylistCoverRegeneration(ctx.db, input);
    expect(reserved).not.toBeNull();
    await ctx.db
      .update(sessionCoverGenerations)
      .set({
        state: 'ready',
        settledAt: new Date(),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      })
      .where(eq(sessionCoverGenerations.id, input.id));
    await insertGeneratedPlaylistCoverImage(ctx.db, {
      id: input.coverImageId,
      ownerUserId,
      playlistId,
      storageProvider: 'local-fs',
      storageKey: input.storageKey,
      byteSize: 1,
      label: 'Playlist fixture cover',
      model: 'test-model',
    });
    return { id: input.id, coverImageId: input.coverImageId, storageKey: input.storageKey };
  }

  async function seedUploadedCover(ownerUserId: string, playlistId: string) {
    const coverImageId = randomUUID();
    const storageKey = `covers/uploaded/${ownerUserId}/${coverImageId}.webp`;
    await ctx.db.insert(coverImages).values({
      id: coverImageId,
      sourceType: 'uploaded',
      storageProvider: 'local-fs',
      storageKey,
      tags: { label: 'Uploaded playlist cover' },
      provenance: { ownerUserId, playlistId },
    });
    return { coverImageId, storageKey };
  }

  it('never records two live attempts for the same playlist', async () => {
    const ownerUserId = await createUser(ctx.db);
    const playlistId = await seedPlaylist(ownerUserId);
    const first = await reservePlaylistCoverRegeneration(
      ctx.db,
      reserveInput(ownerUserId, playlistId),
    );
    expect(first).not.toBeNull();
    expect(first).toMatchObject({
      state: 'reserved',
      trigger: 'user_regenerate',
      playlistId,
      activitySessionId: null,
    });

    const duplicate = await reservePlaylistCoverRegeneration(
      ctx.db,
      reserveInput(ownerUserId, playlistId),
    );
    expect(duplicate).toBeNull();
    expect((await getLivePlaylistCoverGeneration(ctx.db, { ownerUserId, playlistId }))?.id).toBe(
      first!.id,
    );
  });

  it('lets a session live attempt and a playlist live attempt coexist for one owner', async () => {
    const ownerUserId = await createUser(ctx.db);
    const activitySessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const playlistId = await seedPlaylist(ownerUserId);
    const sessionAttemptId = randomUUID();
    const sessionLive = await planSessionCoverGeneration(ctx.db, {
      id: sessionAttemptId,
      ownerUserId,
      activitySessionId,
      plan: {
        sessionName: 'Coexistence fixture',
        coverConcept: null,
        selectedStyle: 'auto',
        resolvedStyle: 'minimal',
        customDefinition: null,
        styleFallbackReason: null,
        concreteScene: 'one scene',
        semanticCueIds: [],
        conceptMode: 'title symbol',
        subjectFamily: 'symbol',
        composition: 'centered',
        palette: 'blue',
        material: 'paper',
        lighting: 'soft',
        referenceTreatment: null,
        prompt: 'fixture',
        exclusions: [],
        altText: 'fixture',
        candidateCount: 1,
      },
      planVersion: 'test-plan',
      promptVersion: 'test-prompt',
      planHash: `plan-${sessionAttemptId}`,
      promptHash: `prompt-${sessionAttemptId}`,
      fingerprint: {},
      providerKey: 'test',
      model: 'test',
      capabilitySnapshot: {},
      idempotencyKey: `cover-${sessionAttemptId}`,
      retryPolicy: {},
      selectedReferences: [],
      coverImageId: randomUUID(),
      storageKey: `covers/${sessionAttemptId}.webp`,
    });
    expect(sessionLive).not.toBeNull();

    const playlistLive = await reservePlaylistCoverRegeneration(
      ctx.db,
      reserveInput(ownerUserId, playlistId),
    );
    expect(playlistLive).not.toBeNull();
    // Both live reservations count against the ONE shared owner cover budget.
    expect(
      await countReservedOrPossiblyPaidCovers(ctx.db, {
        scope: ownerScope(ownerUserId),
        since: new Date(Date.now() - 60_000),
      }),
    ).toBe(2);
  });

  it('deleting a playlist keeps its paid covers counted and settles its live attempt', async () => {
    const ownerUserId = await createUser(ctx.db);
    const playlistId = await seedPlaylist(ownerUserId);
    const paid = await seedReadyAttempt(ownerUserId, playlistId);
    await ctx.db
      .update(sessionCoverGenerations)
      .set({ possiblyPaid: true, submittedAt: new Date() })
      .where(eq(sessionCoverGenerations.id, paid.id));
    // A claimed submission: the provider call may be running, nothing settled yet.
    const inFlight = reserveInput(ownerUserId, playlistId);
    await reservePlaylistCoverRegeneration(ctx.db, inFlight);
    await ctx.db
      .update(sessionCoverGenerations)
      .set({ state: 'submitting', submittedAt: new Date() })
      .where(eq(sessionCoverGenerations.id, inFlight.id));
    const since = new Date(Date.now() - 60_000);

    await expect(deletePlaylist(ctx.db, { ownerUserId, playlistId })).resolves.toBe('deleted');

    for (const scope of [ownerScope(ownerUserId), POOL_SCOPE]) {
      expect(await countReservedOrPossiblyPaidCovers(ctx.db, { scope, since })).toBe(2);
    }
    // No live attempt outlives its subject: nothing could drive or settle it.
    const live = await ctx.pool.query(
      `select 1 from session_cover_generations
       where state in ('reserved', 'planned', 'submitting', 'storing')`,
    );
    expect(live.rowCount).toBe(0);
  });

  it('lists only settled servable covers for the playlist, newest first', async () => {
    const ownerUserId = await createUser(ctx.db);
    const otherOwnerUserId = await createUser(ctx.db);
    const playlistId = await seedPlaylist(ownerUserId);
    const otherPlaylistId = await seedPlaylist(otherOwnerUserId, 'Other');
    const older = await seedReadyAttempt(ownerUserId, playlistId, {
      createdAt: new Date('2026-07-18T10:00:00Z'),
    });
    const newer = await seedReadyAttempt(ownerUserId, playlistId, {
      createdAt: new Date('2026-07-19T10:00:00Z'),
    });
    await seedReadyAttempt(otherOwnerUserId, otherPlaylistId);
    // A live attempt never appears in the history.
    await reservePlaylistCoverRegeneration(ctx.db, reserveInput(ownerUserId, playlistId));

    const history = await listPlaylistCoverHistory(ctx.db, { ownerUserId, playlistId });
    expect(history.map((row) => row.coverImageId)).toEqual([
      newer.coverImageId,
      older.coverImageId,
    ]);

    expect(
      await getPlaylistCoverHistoryEntry(ctx.db, {
        ownerUserId,
        playlistId,
        coverImageId: newer.coverImageId,
      }),
    ).not.toBeNull();
    // Cross-playlist and cross-owner lookups miss.
    expect(
      await getPlaylistCoverHistoryEntry(ctx.db, {
        ownerUserId: otherOwnerUserId,
        playlistId: otherPlaylistId,
        coverImageId: newer.coverImageId,
      }),
    ).toBeNull();
  });

  it('deletes a non-current history cover, queues its bytes, and keeps the ledger row', async () => {
    const ownerUserId = await createUser(ctx.db);
    const playlistId = await seedPlaylist(ownerUserId);
    const current = await seedReadyAttempt(ownerUserId, playlistId);
    const previous = await seedReadyAttempt(ownerUserId, playlistId);
    await setPlaylistCoverImage(ctx.db, {
      ownerUserId,
      playlistId,
      coverImageId: current.coverImageId,
    });

    await expect(
      deletePlaylistCoverFromHistory(ctx.db, {
        ownerUserId,
        playlistId,
        coverImageId: current.coverImageId,
      }),
    ).resolves.toBe('current_cover');
    await expect(
      deletePlaylistCoverFromHistory(ctx.db, {
        ownerUserId,
        playlistId,
        coverImageId: randomUUID(),
      }),
    ).resolves.toBe('not_found');
    await expect(
      deletePlaylistCoverFromHistory(ctx.db, {
        ownerUserId,
        playlistId,
        coverImageId: previous.coverImageId,
      }),
    ).resolves.toBe('deleted');

    const covers = await ctx.db
      .select({ id: coverImages.id })
      .from(coverImages)
      .where(eq(coverImages.id, previous.coverImageId));
    expect(covers).toHaveLength(0);
    const queued = await ctx.pool.query(
      'select storage_key, reason from deletion_queue_items where owner_user_id = $1',
      [ownerUserId],
    );
    expect(queued.rows).toHaveLength(2);
    expect(queued.rows).toEqual(
      expect.arrayContaining([
        { storage_key: previous.storageKey, reason: 'playlist_cover_history_deleted' },
        {
          storage_key: coverRenditionKey(previous.coverImageId),
          reason: 'playlist_cover_history_deleted',
        },
      ]),
    );
    // Spend accounting survives: the ledger row is untouched.
    const [ledger] = await ctx.db
      .select()
      .from(sessionCoverGenerations)
      .where(eq(sessionCoverGenerations.id, previous.id));
    expect(ledger?.state).toBe('ready');
  });

  it('deletes a non-current uploaded cover from the history', async () => {
    const ownerUserId = await createUser(ctx.db);
    const playlistId = await seedPlaylist(ownerUserId);
    const uploaded = await seedUploadedCover(ownerUserId, playlistId);

    await expect(
      deletePlaylistCoverFromHistory(ctx.db, {
        ownerUserId,
        playlistId,
        coverImageId: uploaded.coverImageId,
      }),
    ).resolves.toBe('deleted');
    expect(await listUploadedPlaylistCovers(ctx.db, { ownerUserId, playlistId })).toEqual([]);
    const queued = await ctx.pool.query(
      'select storage_key from deletion_queue_items where owner_user_id = $1',
      [ownerUserId],
    );
    expect(queued.rows).toHaveLength(2);
    expect(queued.rows).toEqual(
      expect.arrayContaining([
        { storage_key: uploaded.storageKey },
        { storage_key: coverRenditionKey(uploaded.coverImageId) },
      ]),
    );
  });

  it('scopes the cover pointer swap to the owner and supports clearing', async () => {
    const ownerUserId = await createUser(ctx.db);
    const otherOwnerUserId = await createUser(ctx.db);
    const playlistId = await seedPlaylist(ownerUserId);
    const attempt = await seedReadyAttempt(ownerUserId, playlistId);

    await expect(
      setPlaylistCoverImage(ctx.db, {
        ownerUserId: otherOwnerUserId,
        playlistId,
        coverImageId: attempt.coverImageId,
      }),
    ).resolves.toBe(false);
    await expect(
      setPlaylistCoverImage(ctx.db, {
        ownerUserId,
        playlistId,
        coverImageId: attempt.coverImageId,
      }),
    ).resolves.toBe(true);
    let [row] = await ctx.db
      .select({ coverImageId: playlists.coverImageId })
      .from(playlists)
      .where(eq(playlists.id, playlistId));
    expect(row!.coverImageId).toBe(attempt.coverImageId);

    await expect(
      setPlaylistCoverImage(ctx.db, { ownerUserId, playlistId, coverImageId: null }),
    ).resolves.toBe(true);
    [row] = await ctx.db
      .select({ coverImageId: playlists.coverImageId })
      .from(playlists)
      .where(eq(playlists.id, playlistId));
    expect(row!.coverImageId).toBeNull();
  });

  it('derives the dominant member genres deterministically, owner-scoped', async () => {
    const ownerUserId = await createUser(ctx.db);
    const playlistId = await seedPlaylist(ownerUserId, 'Deep Focus');
    const genreSets = [['lofi', 'ambient'], ['lofi', 'jazz'], ['lofi', 'ambient'], ['jazz']];
    const activitySessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    for (const [index, genreTags] of genreSets.entries()) {
      const requestId = await createGenerationRequest(ctx.db, { ownerUserId, activitySessionId });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        genreTags,
      });
      await ctx.db.insert(playlistTracks).values({ playlistId, trackId, position: index });
    }

    const subject = await getPlaylistCoverSubject(ctx.db, { ownerUserId, playlistId });
    expect(subject).toMatchObject({ id: playlistId, name: 'Deep Focus', coverImageId: null });
    // 3x lofi, 2x ambient, 2x jazz — ties broken alphabetically.
    expect(subject!.genreTags).toEqual(['lofi', 'ambient', 'jazz']);

    const foreign = await getPlaylistCoverSubject(ctx.db, {
      ownerUserId: await createUser(ctx.db),
      playlistId,
    });
    expect(foreign).toBeNull();
  });
});
