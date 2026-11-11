import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  PHANTOM_SUBMIT_MAX_AGE_MS,
  type ProviderNormalizedStatus,
  type QueueItemState,
} from '@liedmotif/shared';
import {
  activitySessions,
  activitySessionQueueItems,
  coverImages,
  deletionQueueItems,
  generationRequests,
  sessionCoverGenerations,
  playbackEvents,
  providerJobs,
  tracks,
  trackAudioAssets,
  type StyleSnapshot,
} from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createSession,
  createQueueItem,
  createTrack,
  createGenerationRequest,
  createProviderJob,
  createQueueSlotAtRevision,
  createUser,
  markTrackPlayed,
  seedReadyTrack,
  GENERATION_FIXTURE_TABLES,
} from './test-fixtures';
import { addPlaylistTracks, createPlaylist } from '../playlists/playlists-repo';
import { setPlaylistShared } from '../playlists/playlist-share-repo';
import { deleteSession, finishDeferredSessionDeletes } from './session-delete-repo';
import {
  createSession as createSessionCmd,
  getSessionById,
  getSeedSnapshot,
  playSessionTrack,
  reportPlaybackState,
  restyleSession,
  resumeSession,
  setSessionMode,
  stopSession,
} from './session-command-repo';
import { listPinnedSessions, listResumableSessions } from './session-list-repo';
import { getSessionQueue } from './queue-view-repo';
import { listSessionTracks } from './session-tracks-repo';
import { getLibraryTracks, rejectDislikedTrack } from './feedback-repo';
import { setSessionPinned } from './session-pin-repo';
import { deleteTrack } from './delete-track-repo';
import { countInFlightSessionJobs, countReadyAheadTracks } from './sessions-repo';
import { countLegacyGeneratedCoversInWindow } from '../covers/generated-repo';
import { acquireOwnerCoverAdmissionLock } from '../covers/generation-ledger-repo';
import { PLACEHOLDER_COVER_ID, seedPlaceholderCover } from '../covers/placeholder';
import { withTransaction, type DbOrTx } from '../transactions';
import { ownerScope } from '../member-pool';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

/** A blend-ready Style Snapshot fixture. */
function snapshot(stylePrompt = 'instrumental lofi, low energy'): StyleSnapshot {
  return {
    stylePrompt,
    negativeTerms: ['vocals'],
    genreTags: ['lofi'],
    vocalMode: 'instrumental',
    energy: 'low',
    bpm: 82,
    key: 'A minor',
    seedParameters: { baseSeed: 1234, rerollSalt: 0 },
  };
}

async function readSession(ctx: TestDb, id: string) {
  const [row] = await ctx.db.select().from(activitySessions).where(eq(activitySessions.id, id));
  return row!;
}

describeIfDb('session-command-repo — lifecycle writers', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-session-command-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    // `cover_images` is not in the shared fixture list (it is instance-global),
    // but this suite seeds cover rows whose provenance names deterministic
    // fixture user ids — leftovers from a previous run would pollute the
    // legacy-cover counting assertions.
    await truncateTables(ctx.pool, [...GENERATION_FIXTURE_TABLES, 'cover_images']);
  });

  describe('createSession', () => {
    it('creates an active session and persists the frozen Style Snapshot', async () => {
      const ownerUserId = await createUser(ctx.db);
      const result = await createSessionCmd(ctx.db, {
        ownerUserId,
        sessionMode: 'keep_going',
        snapshot: snapshot(),
        title: 'Focus lofi',
      });

      expect(result.session.status).toBe('active');
      expect(result.session.title).toBe('Focus lofi');
      expect(result.session.sessionMode).toBe('keep_going');
      expect(result.supersededSessionId).toBeNull();
      // The single Style Snapshot is persisted with its frozen BPM/key.
      expect(result.session.sessionStyleSnapshot?.bpm).toBe(82);
      expect(result.session.sessionStyleSnapshot?.key).toBe('A minor');
      // Cover-art defaults: `auto` lane, no custom hint.
      expect(result.session.coverStyle).toBe('auto');
      expect(result.session.coverStyleHint).toBeNull();
    });

    it('persists one authoritative preset or Custom style state', async () => {
      const ownerUserId = await createUser(ctx.db);
      const result = await createSessionCmd(ctx.db, {
        ownerUserId,
        sessionMode: 'keep_going',
        snapshot: snapshot(),
        coverStyle: 'poster_art',
        coverStyleHint: '  bold ink lines  ',
      });
      expect(result.session.coverStyle).toBe('poster_art');
      expect(result.session.coverStyleHint).toBeNull();

      const custom = await createSessionCmd(ctx.db, {
        ownerUserId,
        sessionMode: 'keep_going',
        snapshot: snapshot(),
        coverStyle: 'custom',
        coverStyleHint: '  bold ink lines  ',
      });
      expect(custom.session.coverStyle).toBe('custom');
      expect(custom.session.coverStyleHint).toBe('bold ink lines');
      expect(custom.session.coverStyleHintNormalized).toBe('bold ink lines');

      // A blank hint stores null, not an empty string.
      const blank = await createSessionCmd(ctx.db, {
        ownerUserId,
        sessionMode: 'keep_going',
        snapshot: snapshot(),
        coverStyle: 'custom',
        coverStyleHint: '   ',
      });
      expect(blank.session.coverStyle).toBe('auto');
      expect(blank.session.coverStyleHint).toBeNull();
      expect(blank.session.coverStyleFallbackReason).toBe('invalid_custom_fell_back_to_auto');
    });

    it('persists the caller-decided starting mode (the owner Buffer default)', async () => {
      const ownerUserId = await createUser(ctx.db);
      const result = await createSessionCmd(ctx.db, {
        ownerUserId,
        sessionMode: 'repeat',
        snapshot: snapshot(),
      });
      expect(result.session.sessionMode).toBe('repeat');
    });

    it('persists the skip-profile flag, defaulting to off', async () => {
      const ownerUserId = await createUser(ctx.db);
      const defaulted = await createSessionCmd(ctx.db, {
        ownerUserId,
        sessionMode: 'keep_going',
        snapshot: snapshot(),
      });
      expect(defaulted.session.skipProfile).toBe(false);

      const skipped = await createSessionCmd(ctx.db, {
        ownerUserId,
        sessionMode: 'keep_going',
        snapshot: snapshot(),
        skipProfile: true,
      });
      expect(skipped.session.skipProfile).toBe(true);
    });

    it('supersedes the prior active session (endReason=superseded) — one active per owner', async () => {
      const ownerUserId = await createUser(ctx.db);
      const priorId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      await ctx.db
        .update(activitySessions)
        .set({ vibeSwitchRevision: 2 })
        .where(eq(activitySessions.id, priorId));

      const result = await createSessionCmd(ctx.db, {
        ownerUserId,
        sessionMode: 'keep_going',
        snapshot: snapshot(),
      });

      expect(result.supersededSessionId).toBe(priorId);
      const prior = await readSession(ctx, priorId);
      expect(prior.status).toBe('stopped');
      expect(prior.endReason).toBe('superseded');
      expect(prior.stoppedAt).not.toBeNull();
      expect(prior.vibeSwitchRevision).toBeNull();

      const actives = await ctx.db
        .select({ id: activitySessions.id })
        .from(activitySessions)
        .where(eq(activitySessions.status, 'active'));
      expect(actives).toHaveLength(1);
      expect(actives[0]!.id).toBe(result.session.id);
    });

    it('serializes two simultaneous starts (double-tap, two tabs) into one active session', async () => {
      const ownerUserId = await createUser(ctx.db);
      // The pool opens connections lazily, so the second start would otherwise
      // wait out a handshake and simply follow the first instead of racing it.
      await Promise.all([ctx.pool.query('select 1'), ctx.pool.query('select 1')]);

      // Unserialized, both starts find no active session to supersede and both
      // insert one — the partial unique index rejects the loser with a 23505 the
      // route has no handler for.
      const results = await Promise.all([
        createSessionCmd(ctx.db, { ownerUserId, sessionMode: 'keep_going', snapshot: snapshot() }),
        createSessionCmd(ctx.db, { ownerUserId, sessionMode: 'keep_going', snapshot: snapshot() }),
      ]);

      const rows = await ctx.db
        .select({ id: activitySessions.id, status: activitySessions.status })
        .from(activitySessions)
        .where(eq(activitySessions.ownerUserId, ownerUserId));
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);
      // Serialized, the loser supersedes the winner rather than colliding with it.
      expect(results.filter((result) => result.supersededSessionId !== null)).toHaveLength(1);
    });
  });

  describe('stopSession', () => {
    it('writes endReason=user_stopped and moves the session to stopped', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });

      const result = await stopSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toEqual({ id: sessionId, status: 'stopped' });

      const row = await readSession(ctx, sessionId);
      expect(row.status).toBe('stopped');
      expect(row.endReason).toBe('user_stopped');
      expect(row.stoppedAt).not.toBeNull();
    });

    it('is an idempotent no-op for an already-stopped session (keeps its prior endReason)', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      // Seed a prior end reason so we can prove the no-op does not overwrite it.
      await ctx.db
        .update(activitySessions)
        .set({ endReason: 'idle_timeout' })
        .where(eq(activitySessions.id, sessionId));

      const result = await stopSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toEqual({ id: sessionId, status: 'stopped' });
      const row = await readSession(ctx, sessionId);
      expect(row.endReason).toBe('idle_timeout');
    });

    it('returns null for a session the user does not own', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId: otherId, status: 'active' });

      const result = await stopSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toBeNull();
      // The other user's session is untouched.
      expect((await readSession(ctx, sessionId)).status).toBe('active');
    });
  });

  describe('deleteSession', () => {
    async function seedCoverLedger(
      ownerUserId: string,
      sessionId: string,
      state: 'planned' | 'quality_rejected',
      database: DbOrTx = ctx.db,
    ) {
      const id = crypto.randomUUID();
      const coverImageId = crypto.randomUUID();
      await database.insert(sessionCoverGenerations).values({
        id,
        ownerUserId,
        activitySessionId: sessionId,
        state,
        possiblyPaid: state === 'quality_rejected',
        plan: {
          sessionName: 'Deletion Test',
          coverConcept: null,
          selectedStyle: 'minimal',
          resolvedStyle: 'minimal',
          customDefinition: null,
          styleFallbackReason: null,
          concreteScene: 'one circle',
          semanticCueIds: ['name:metaphor'],
          conceptMode: 'title symbol',
          subjectFamily: 'circle',
          composition: 'centered',
          palette: 'black and white',
          material: 'paper',
          lighting: 'flat',
          referenceTreatment: null,
          prompt: 'controlled prompt',
          exclusions: ['text'],
          altText: 'Deletion Test — one circle',
          candidateCount: 1,
        },
        planVersion: 'test-plan',
        promptVersion: 'test-prompt',
        planHash: `plan-${id}`,
        promptHash: `prompt-${id}`,
        fingerprint: {},
        providerKey: 'test',
        model: 'test',
        capabilitySnapshot: {},
        idempotencyKey: `cover:${id}`,
        retryPolicy: { maxAttempts: 1 },
        selectedReferences: [],
        coverImageId,
        storageKey: `covers/${id}.webp`,
      });
      return { id, coverImageId };
    }

    it('serializes deletion behind admission and defers it for a newly reserved cover', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      let signalLocked!: () => void;
      let releaseAdmission!: () => void;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });

      const admission = withTransaction(ctx.db, async (tx) => {
        await acquireOwnerCoverAdmissionLock(tx, ownerUserId);
        signalLocked();
        await release;
        await seedCoverLedger(ownerUserId, sessionId, 'planned', tx);
      });
      await locked;

      let deletionSettled = false;
      const deletion = deleteSession(ctx.db, { ownerUserId, sessionId }).then((result) => {
        deletionSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(deletionSettled).toBe(false);

      releaseAdmission();
      await admission;
      await expect(deletion).resolves.toEqual({ ok: true, id: sessionId, deferred: true });
      expect((await readSession(ctx, sessionId)).status).toBe('stopped');
    });

    /** Owner + stopped session + one generated track (ephemeral by default). */
    async function seedStoppedSessionWithTrack(overrides: {
      savedAt?: Date;
      audioStorageKey?: string;
    }) {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        normalizedStatus: 'ready',
      });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'ready',
        savedAt: overrides.savedAt ?? null,
        audioStorageKey: overrides.audioStorageKey ?? 'audio/track-final.mp3',
      });
      await createQueueItem(ctx.db, { activitySessionId: sessionId, trackId, position: 0 });
      await markTrackPlayed(ctx.db, { ownerUserId, activitySessionId: sessionId, trackId });
      return { ownerUserId, sessionId, requestId, trackId };
    }

    it('deletes a stopped session and reclaims its ephemeral audio; spend rows survive with the session edge severed', async () => {
      const { ownerUserId, sessionId, requestId, trackId } = await seedStoppedSessionWithTrack({});

      const result = await deleteSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toEqual({ ok: true, id: sessionId, deferred: false, evictedTrackCount: 1 });

      // The session identity is gone: row, queue items, playback events.
      const [session] = await ctx.db
        .select()
        .from(activitySessions)
        .where(eq(activitySessions.id, sessionId));
      expect(session).toBeUndefined();
      expect(
        await ctx.db
          .select()
          .from(activitySessionQueueItems)
          .where(eq(activitySessionQueueItems.activitySessionId, sessionId)),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .select()
          .from(playbackEvents)
          .where(eq(playbackEvents.activitySessionId, sessionId)),
      ).toHaveLength(0);

      // Spend accounting survives: the request row stays, session edge set null.
      const [request] = await ctx.db
        .select()
        .from(generationRequests)
        .where(eq(generationRequests.id, requestId));
      expect(request).toBeDefined();
      expect(request!.activitySessionId).toBeNull();

      // The ephemeral track's audio is reclaimed exactly like the recurring sweep:
      // row kept as `deleted`, asset rows dropped, file queued for deletion.
      const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
      expect(track!.status).toBe('deleted');
      expect(
        await ctx.db.select().from(trackAudioAssets).where(eq(trackAudioAssets.trackId, trackId)),
      ).toHaveLength(0);
      const queued = await ctx.db
        .select()
        .from(deletionQueueItems)
        .where(eq(deletionQueueItems.trackId, trackId));
      expect(queued).toHaveLength(1);
      expect(queued[0]!.storageKey).toBe('audio/track-final.mp3');
      expect(queued[0]!.reason).toBe('ephemeral_eviction');
    });

    it('keeps a Saved track and its audio in the Library', async () => {
      const { ownerUserId, sessionId, trackId } = await seedStoppedSessionWithTrack({
        savedAt: new Date(),
      });

      const result = await deleteSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toEqual({ ok: true, id: sessionId, deferred: false, evictedTrackCount: 0 });

      const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
      expect(track!.status).toBe('ready');
      expect(track!.savedAt).not.toBeNull();
      expect(
        await ctx.db.select().from(trackAudioAssets).where(eq(trackAudioAssets.trackId, trackId)),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .select()
          .from(deletionQueueItems)
          .where(eq(deletionQueueItems.trackId, trackId)),
      ).toHaveLength(0);
    });

    it('defers deletion for live Cover work and retains terminal spend after deletion', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      const ledger = await seedCoverLedger(ownerUserId, sessionId, 'planned');

      await expect(deleteSession(ctx.db, { ownerUserId, sessionId })).resolves.toEqual({
        ok: true,
        id: sessionId,
        deferred: true,
      });
      await ctx.db
        .update(sessionCoverGenerations)
        .set({ state: 'quality_rejected', possiblyPaid: true })
        .where(eq(sessionCoverGenerations.id, ledger.id));
      await ctx.db.insert(coverImages).values({
        id: ledger.coverImageId,
        sourceType: 'generated',
        storageProvider: 'local-fs',
        storageKey: `covers/${ledger.coverImageId}.webp`,
        provenance: { ownerUserId, activitySessionId: sessionId },
      });
      expect(
        await countLegacyGeneratedCoversInWindow(ctx.db, {
          scope: ownerScope(ownerUserId),
          since: new Date(0),
        }),
      ).toBe(0);

      await expect(deleteSession(ctx.db, { ownerUserId, sessionId })).resolves.toMatchObject({
        ok: true,
        id: sessionId,
      });
      const [retained] = await ctx.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.id, ledger.id));
      expect(retained).toMatchObject({
        ownerUserId,
        activitySessionId: null,
        possiblyPaid: true,
        state: 'quality_rejected',
      });
      expect(
        await countLegacyGeneratedCoversInWindow(ctx.db, {
          scope: ownerScope(ownerUserId),
          since: new Date(0),
        }),
      ).toBe(0);
    });

    it('refuses an active session (Stop is the lifecycle move)', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });

      const result = await deleteSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toEqual({ ok: false, reason: 'active' });
      expect((await readSession(ctx, sessionId)).status).toBe('active');
    });

    it('defers the delete while a provider job is in flight, hiding the session until it settles', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      await ctx.db
        .update(activitySessions)
        .set({ pinnedAt: new Date() })
        .where(eq(activitySessions.id, sessionId));
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        submitState: 'submitted',
        normalizedStatus: 'processing',
      });

      const { trackId } = await seedReadyTrack(ctx.db, { ownerUserId, sessionId });

      const requestedAt = new Date('2026-01-01T00:00:00Z');
      expect(await deleteSession(ctx.db, { ownerUserId, sessionId, now: requestedAt })).toEqual({
        ok: true,
        id: sessionId,
        deferred: true,
      });
      // Asking again keeps the first request instant.
      await deleteSession(ctx.db, { ownerUserId, sessionId });
      expect(await readSession(ctx, sessionId)).toMatchObject({
        status: 'stopped',
        deleteRequestedAt: requestedAt,
        pinnedAt: null,
      });

      // Gone from every way back in: My Sessions, pinning, Resume, playing a
      // track through it — its tracks read as from a deleted session.
      const listed = await listResumableSessions(ctx.db, { ownerUserId, limit: 10 });
      expect(listed.items).toHaveLength(0);
      expect(await listPinnedSessions(ctx.db, { ownerUserId })).toHaveLength(0);
      expect(await setSessionPinned(ctx.db, { ownerUserId, sessionId, pinned: true })).toBe(
        'not_found',
      );
      expect(await resumeSession(ctx.db, { ownerUserId, sessionId })).toEqual({
        ok: false,
        reason: 'not_found',
      });
      expect(await playSessionTrack(ctx.db, { ownerUserId, sessionId, trackId })).toEqual({
        ok: false,
        reason: 'not_found',
      });
      expect(
        await listSessionTracks(ctx.db, { ownerUserId, sessionId, cursor: null, limit: 10 }),
      ).toBeNull();
      const library = await getLibraryTracks(ctx.db, { ownerUserId, view: 'history', limit: 10 });
      expect(library.items.find((item) => item.id === trackId)).toMatchObject({
        originSessionId: null,
        originSessionTitle: null,
      });

      // The sweep leaves it while the job is live, then finishes it once settled.
      expect(await finishDeferredSessionDeletes(ctx.db)).toEqual({
        deletedSessionIds: [],
        failedSessionIds: [],
      });
      await ctx.db
        .update(providerJobs)
        .set({ normalizedStatus: 'ready' })
        .where(eq(providerJobs.id, jobId));
      expect(await finishDeferredSessionDeletes(ctx.db)).toEqual({
        deletedSessionIds: [sessionId],
        failedSessionIds: [],
      });
      expect(
        await ctx.db.select().from(activitySessions).where(eq(activitySessions.id, sessionId)),
      ).toHaveLength(0);
    });

    it('ignores a phantom submit older than the slot-hold bound', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      // A parked uncertain submit past the phantom bound no longer holds a slot.
      await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        submitState: 'submit_unknown',
        normalizedStatus: 'submit_unknown',
        updatedAt: new Date(Date.now() - PHANTOM_SUBMIT_MAX_AGE_MS - 60_000),
      });

      const result = await deleteSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toEqual({ ok: true, id: sessionId, deferred: false, evictedTrackCount: 0 });
    });

    it('returns not_found for a session the user does not own', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId: otherId, status: 'stopped' });

      const result = await deleteSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect((await readSession(ctx, sessionId)).status).toBe('stopped');
    });

    /** A generated cover row the session can point at / list in its history. */
    async function seedGeneratedCover() {
      const id = crypto.randomUUID();
      await ctx.db.insert(coverImages).values({
        id,
        sourceType: 'generated',
        storageProvider: 'local-fs',
        storageKey: `covers/generated/test/${id}.webp`,
        provenance: {},
      });
      return id;
    }

    /** One more generated Ephemeral audio-bearing track in an existing session. */
    async function seedTrackInSession(ownerUserId: string, sessionId: string) {
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        normalizedStatus: 'ready',
      });
      return createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'ready',
        audioStorageKey: `audio/${crypto.randomUUID()}.mp3`,
      });
    }

    async function readCover(id: string) {
      const [row] = await ctx.db.select().from(coverImages).where(eq(coverImages.id, id));
      return row ?? null;
    }

    async function queuedStorageKeys() {
      const rows = await ctx.db.select().from(deletionQueueItems);
      return rows.map((row) => row.storageKey);
    }

    it('snapshots the session cover onto surviving tracks; evicted tracks stay bare', async () => {
      const { ownerUserId, sessionId, trackId } = await seedStoppedSessionWithTrack({
        savedAt: new Date(),
      });
      const ephemeral = await seedTrackInSession(ownerUserId, sessionId);
      // The cover is a settled ledger attempt — a genuine reclaim candidate that
      // must survive ONLY because the snapshot makes a track reference it.
      const ledger = await seedCoverLedger(ownerUserId, sessionId, 'quality_rejected');
      const coverKey = `covers/generated/test/${ledger.coverImageId}.webp`;
      await ctx.db.insert(coverImages).values({
        id: ledger.coverImageId,
        sourceType: 'generated',
        storageProvider: 'local-fs',
        storageKey: coverKey,
        provenance: { ownerUserId, activitySessionId: sessionId },
      });
      await ctx.db
        .update(activitySessions)
        .set({ coverImageId: ledger.coverImageId })
        .where(eq(activitySessions.id, sessionId));

      const result = await deleteSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toMatchObject({ ok: true, id: sessionId });

      // The Saved track owns the cover now — the coalesce keeps rendering it.
      const [saved] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
      expect(saved!.coverImageId).toBe(ledger.coverImageId);
      // The evicted Ephemeral track gets no pointer.
      const [evicted] = await ctx.db.select().from(tracks).where(eq(tracks.id, ephemeral));
      expect(evicted!.coverImageId).toBeNull();
      // A cover a surviving track references is NOT reclaimed.
      expect(await readCover(ledger.coverImageId)).not.toBeNull();
      expect(await queuedStorageKeys()).not.toContain(coverKey);
    });

    it('never overwrites a track cover pointer that is already set', async () => {
      const sessionCover = await seedGeneratedCover();
      const ownCover = await seedGeneratedCover();
      const { ownerUserId, sessionId, trackId } = await seedStoppedSessionWithTrack({
        savedAt: new Date(),
      });
      await ctx.db.update(tracks).set({ coverImageId: ownCover }).where(eq(tracks.id, trackId));
      await ctx.db
        .update(activitySessions)
        .set({ coverImageId: sessionCover })
        .where(eq(activitySessions.id, sessionId));

      await deleteSession(ctx.db, { ownerUserId, sessionId });
      const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
      expect(track!.coverImageId).toBe(ownCover);
    });

    it('reclaims unreferenced session cover art: current, history, and uploads', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      // Current cover, backed by a settled ledger attempt.
      const ledger = await seedCoverLedger(ownerUserId, sessionId, 'quality_rejected');
      await ctx.db.insert(coverImages).values({
        id: ledger.coverImageId,
        sourceType: 'generated',
        storageProvider: 'local-fs',
        storageKey: `covers/generated/${ownerUserId}/${sessionId}/${ledger.coverImageId}.webp`,
        provenance: { ownerUserId, activitySessionId: sessionId },
      });
      await ctx.db
        .update(activitySessions)
        .set({ coverImageId: ledger.coverImageId })
        .where(eq(activitySessions.id, sessionId));
      // An uploaded cover in the session's history (provenance-matched).
      const uploadedId = crypto.randomUUID();
      await ctx.db.insert(coverImages).values({
        id: uploadedId,
        sourceType: 'uploaded',
        storageProvider: 'local-fs',
        storageKey: `covers/uploaded/${ownerUserId}/${uploadedId}.webp`,
        provenance: { ownerUserId, activitySessionId: sessionId },
      });

      const result = await deleteSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toMatchObject({ ok: true, id: sessionId });

      // Both cover rows are gone and both files (plus renditions) are queued.
      expect(await readCover(ledger.coverImageId)).toBeNull();
      expect(await readCover(uploadedId)).toBeNull();
      const keys = await queuedStorageKeys();
      expect(keys).toContain(
        `covers/generated/${ownerUserId}/${sessionId}/${ledger.coverImageId}.webp`,
      );
      expect(keys).toContain(`covers/uploaded/${ownerUserId}/${uploadedId}.webp`);
      expect(keys).toContain(`covers/renditions/${ledger.coverImageId}-w160.webp`);
      expect(keys).toContain(`covers/renditions/${uploadedId}-w160.webp`);

      // The ledger row SURVIVES as cover-spend accounting, edge severed.
      const [retained] = await ctx.db
        .select()
        .from(sessionCoverGenerations)
        .where(eq(sessionCoverGenerations.id, ledger.id));
      expect(retained).toMatchObject({ activitySessionId: null, possiblyPaid: true });
    });

    it('leaves the built-in placeholder cover alone', async () => {
      await seedPlaceholderCover(ctx.db);
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        status: 'stopped',
        coverImageId: PLACEHOLDER_COVER_ID,
      });

      const result = await deleteSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toMatchObject({ ok: true, id: sessionId });
      expect(await readCover(PLACEHOLDER_COVER_ID)).not.toBeNull();
      expect(await queuedStorageKeys()).toHaveLength(0);
    });
  });

  describe('resumeSession', () => {
    it('re-activates a Stopped session, sets lastResumedAt, resets generationStatus to ok, clears endReason', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        status: 'stopped',
        generationStatus: 'provider_error',
        styleSnapshot: snapshot('resumed style'),
      });
      await ctx.db
        .update(activitySessions)
        .set({ endReason: 'idle_timeout' })
        .where(eq(activitySessions.id, sessionId));

      const result = await resumeSession(ctx.db, { ownerUserId, sessionId });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.session.status).toBe('active');
      expect(result.supersededSessionId).toBeNull();

      const row = await readSession(ctx, sessionId);
      expect(row.status).toBe('active');
      expect(row.lastResumedAt).not.toBeNull();
      expect(row.generationStatus).toBe('ok');
      expect(row.endReason).toBeNull();
      // Same identity + stored snapshot preserved.
      expect(row.sessionStyleSnapshot?.stylePrompt).toBe('resumed style');
    });

    it('stops the current active session (endReason=superseded) when resuming another', async () => {
      const ownerUserId = await createUser(ctx.db);
      const activeId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const stoppedId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });

      const result = await resumeSession(ctx.db, { ownerUserId, sessionId: stoppedId });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.supersededSessionId).toBe(activeId);

      const superseded = await readSession(ctx, activeId);
      expect(superseded.status).toBe('stopped');
      expect(superseded.endReason).toBe('superseded');
      // Exactly one active session for the owner afterwards.
      const actives = await ctx.db
        .select({ id: activitySessions.id })
        .from(activitySessions)
        .where(eq(activitySessions.status, 'active'));
      expect(actives.map((a) => a.id)).toEqual([stoppedId]);
    });

    it('refuses to resume a session that is not Stopped', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const result = await resumeSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toEqual({ ok: false, reason: 'not_resumable' });
    });

    it('returns not_found for an unknown / unowned session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId: otherId, status: 'stopped' });
      const result = await resumeSession(ctx.db, { ownerUserId, sessionId });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  describe('playSessionTrack', () => {
    /** A session with one queued Track; returns ids incl. its queue slot. */
    async function seedSessionTrack(
      ownerUserId: string,
      status: 'active' | 'stopped',
    ): Promise<{ sessionId: string; trackId: string; queueItemId: string }> {
      const sessionId = await createSession(ctx.db, { ownerUserId, status });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const providerJobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId,
        audioStorageKey: 'test/session-selection.mp3',
      });
      const queueItemId = await createQueueItem(ctx.db, {
        activitySessionId: sessionId,
        trackId,
        generationRequestId: requestId,
        position: 0,
        state: 'played',
      });
      return { sessionId, trackId, queueItemId };
    }

    it('resumes a Stopped session positioned at the track, superseding the active one', async () => {
      const ownerUserId = await createUser(ctx.db);
      const activeId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const { sessionId, trackId, queueItemId } = await seedSessionTrack(ownerUserId, 'stopped');

      const result = await playSessionTrack(ctx.db, { ownerUserId, sessionId, trackId });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.session.status).toBe('active');
      expect(result.supersededSessionId).toBe(activeId);

      const row = await readSession(ctx, sessionId);
      expect(row.status).toBe('active');
      expect(row.lastResumedAt).not.toBeNull();
      expect(row.currentQueueItemId).toBe(queueItemId);
      expect(row.currentTrackId).toBe(trackId);
    });

    it('only moves the cursor of an Active session (no lifecycle write, no supersede)', async () => {
      const ownerUserId = await createUser(ctx.db);
      const { sessionId, trackId, queueItemId } = await seedSessionTrack(ownerUserId, 'active');
      const before = await readSession(ctx, sessionId);

      const result = await playSessionTrack(ctx.db, { ownerUserId, sessionId, trackId });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.supersededSessionId).toBeNull();

      const row = await readSession(ctx, sessionId);
      expect(row.status).toBe('active');
      expect(row.lastResumedAt).toEqual(before.lastResumedAt);
      expect(row.currentQueueItemId).toBe(queueItemId);
      expect(row.currentTrackId).toBe(trackId);
    });

    it('refuses a track belonging to another session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const { sessionId } = await seedSessionTrack(ownerUserId, 'active');
      const foreign = await seedSessionTrack(ownerUserId, 'stopped');

      const result = await playSessionTrack(ctx.db, {
        ownerUserId,
        sessionId,
        trackId: foreign.trackId,
      });
      expect(result).toEqual({ ok: false, reason: 'track_not_in_session' });
      expect((await readSession(ctx, sessionId)).currentTrackId).toBeNull();
    });

    it('returns not_found for an unowned session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      const foreign = await seedSessionTrack(otherId, 'stopped');

      const result = await playSessionTrack(ctx.db, {
        ownerUserId,
        sessionId: foreign.sessionId,
        trackId: foreign.trackId,
      });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  describe('setSessionMode (voluntary Repeat control)', () => {
    it('sets sessionMode=repeat', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });

      const updated = await setSessionMode(ctx.db, { ownerUserId, sessionId, mode: 'repeat' });
      expect(updated?.sessionMode).toBe('repeat');
      expect((await readSession(ctx, sessionId)).sessionMode).toBe('repeat');
    });

    it('returns null for an unowned session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId: otherId, status: 'active' });
      const updated = await setSessionMode(ctx.db, { ownerUserId, sessionId, mode: 'repeat' });
      expect(updated).toBeNull();
    });
  });

  describe('restyleSession (Change Vibe)', () => {
    it('replaces the Style Snapshot in place, keeping the same active session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        status: 'active',
        styleSnapshot: snapshot('old vibe'),
      });

      const result = await restyleSession(ctx.db, {
        ownerUserId,
        sessionId,
        snapshot: snapshot('new vibe'),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.session.id).toBe(sessionId);
      expect(result.session.status).toBe('active');
      expect(result.session.sessionStyleSnapshot?.stylePrompt).toBe('new vibe');
    });

    it('leaves the Name untouched, named or not (nothing re-derives over a Name)', async () => {
      // Two owners — one active session per owner is a schema invariant.
      const namedOwner = await createUser(ctx.db);
      const namedId = await createSession(ctx.db, {
        ownerUserId: namedOwner,
        status: 'active',
        title: 'Given Name',
        styleSnapshot: snapshot('old vibe'),
      });
      const unnamedOwner = await createUser(ctx.db);
      const unnamedId = await createSession(ctx.db, {
        ownerUserId: unnamedOwner,
        status: 'active',
        styleSnapshot: snapshot('old vibe'),
      });

      const named = await restyleSession(ctx.db, {
        ownerUserId: namedOwner,
        sessionId: namedId,
        snapshot: snapshot('new vibe'),
      });
      if (!named.ok) throw new Error('unreachable');
      expect(named.session.title).toBe('Given Name');

      const unnamed = await restyleSession(ctx.db, {
        ownerUserId: unnamedOwner,
        sessionId: unnamedId,
        snapshot: snapshot('new vibe'),
      });
      if (!unnamed.ok) throw new Error('unreachable');
      expect(unnamed.session.title).toBeNull();
    });

    it('keeps track titles a refill appended after the change read the session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        status: 'active',
        styleSnapshot: { ...snapshot('old vibe'), trackTitles: ['Amber Rain', 'Night Signal'] },
      });

      const result = await restyleSession(ctx.db, {
        ownerUserId,
        sessionId,
        snapshot: { ...snapshot('new vibe'), trackTitles: ['Amber Rain'] },
      });
      if (!result.ok) throw new Error('unreachable');
      expect(result.session.sessionStyleSnapshot).toMatchObject({
        stylePrompt: 'new vibe',
        trackTitles: ['Amber Rain', 'Night Signal'],
      });
    });

    it('refuses to re-style a stopped session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      const result = await restyleSession(ctx.db, {
        ownerUserId,
        sessionId,
        snapshot: snapshot(),
      });
      expect(result).toEqual({ ok: false, reason: 'not_active' });
    });

    it('bumps styleRevision atomically with each snapshot replacement (blend identity)', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        status: 'active',
        styleSnapshot: snapshot('old vibe'),
      });
      // A fresh session starts at revision 1.
      const before = await getSessionById(ctx.db, { ownerUserId, sessionId });
      expect(before?.styleRevision).toBe(1);

      // Each restyle returns the NEW snapshot together with the NEW revision from
      // the same UPDATE's RETURNING row — the atomicity guarantee is structural
      // (one UPDATE sets both), so no reader can see a mixed pair.
      const first = await restyleSession(ctx.db, {
        ownerUserId,
        sessionId,
        snapshot: snapshot('new vibe'),
      });
      if (!first.ok) throw new Error('unreachable');
      expect(first.session.styleRevision).toBe(2);
      expect(first.session.sessionStyleSnapshot?.stylePrompt).toBe('new vibe');

      const second = await restyleSession(ctx.db, {
        ownerUserId,
        sessionId,
        snapshot: snapshot('third vibe'),
      });
      if (!second.ok) throw new Error('unreachable');
      expect(second.session.styleRevision).toBe(3);
    });

    it('a refused restyle leaves styleRevision untouched', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      await restyleSession(ctx.db, { ownerUserId, sessionId, snapshot: snapshot() });
      const after = await getSessionById(ctx.db, { ownerUserId, sessionId });
      expect(after?.styleRevision).toBe(1);
    });

    it('a switch-now restyle arms the switch at the new revision; a plain one clears it', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        status: 'active',
        styleSnapshot: snapshot('old vibe'),
      });

      const armed = await restyleSession(ctx.db, {
        ownerUserId,
        sessionId,
        snapshot: snapshot('new vibe'),
        switchImmediately: true,
      });
      if (!armed.ok) throw new Error('unreachable');
      // Armed at exactly the revision this restyle minted.
      expect(armed.session.styleRevision).toBe(2);
      expect(armed.session.vibeSwitchRevision).toBe(2);

      // A later toggled change re-arms at ITS revision…
      const rearmed = await restyleSession(ctx.db, {
        ownerUserId,
        sessionId,
        snapshot: snapshot('third vibe'),
        switchImmediately: true,
      });
      if (!rearmed.ok) throw new Error('unreachable');
      expect(rearmed.session.vibeSwitchRevision).toBe(3);

      // …and a play-out change supersedes any armed switch.
      const cleared = await restyleSession(ctx.db, {
        ownerUserId,
        sessionId,
        snapshot: snapshot('fourth vibe'),
      });
      if (!cleared.ok) throw new Error('unreachable');
      expect(cleared.session.vibeSwitchRevision).toBeNull();
    });

    it('stopSession clears an armed vibe switch', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        status: 'active',
        styleSnapshot: snapshot('old vibe'),
      });
      await restyleSession(ctx.db, {
        ownerUserId,
        sessionId,
        snapshot: snapshot('new vibe'),
        switchImmediately: true,
      });

      const stopped = await stopSession(ctx.db, { ownerUserId, sessionId });
      expect(stopped?.status).toBe('stopped');
      const after = await getSessionById(ctx.db, { ownerUserId, sessionId });
      expect(after?.vibeSwitchRevision).toBeNull();
    });
  });

  describe('listResumableSessions (My Sessions)', () => {
    it('returns only resumable Stopped sessions, most-recently-active first', async () => {
      const ownerUserId = await createUser(ctx.db);
      await createSession(ctx.db, { ownerUserId, status: 'active' });
      const older = await createSession(ctx.db, {
        ownerUserId,
        status: 'stopped',
        lastPlaybackReportAt: new Date('2026-06-01T00:00:00Z'),
      });
      const newer = await createSession(ctx.db, {
        ownerUserId,
        status: 'stopped',
        lastPlaybackReportAt: new Date('2026-06-20T00:00:00Z'),
      });

      const result = await listResumableSessions(ctx.db, { ownerUserId, limit: 50 });
      expect(result.items.map((s) => s.id)).toEqual([newer, older]);
      expect(result.items.every((s) => s.status === 'stopped')).toBe(true);
      expect(result.nextCursor).toBeNull();
    });

    it('paginates with a cursor', async () => {
      const ownerUserId = await createUser(ctx.db);
      const a = await createSession(ctx.db, {
        ownerUserId,
        status: 'stopped',
        lastPlaybackReportAt: new Date('2026-06-03T00:00:00Z'),
      });
      const b = await createSession(ctx.db, {
        ownerUserId,
        status: 'stopped',
        lastPlaybackReportAt: new Date('2026-06-02T00:00:00Z'),
      });
      const c = await createSession(ctx.db, {
        ownerUserId,
        status: 'stopped',
        lastPlaybackReportAt: new Date('2026-06-01T00:00:00Z'),
      });

      const page1 = await listResumableSessions(ctx.db, { ownerUserId, limit: 2 });
      expect(page1.items.map((s) => s.id)).toEqual([a, b]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listResumableSessions(ctx.db, {
        ownerUserId,
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.items.map((s) => s.id)).toEqual([c]);
      expect(page2.nextCursor).toBeNull();
    });

    it('does not leak another user’s sessions', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      await createSession(ctx.db, { ownerUserId: otherId, status: 'stopped' });
      const mine = await createSession(ctx.db, { ownerUserId, status: 'stopped' });

      const result = await listResumableSessions(ctx.db, { ownerUserId, limit: 50 });
      expect(result.items.map((s) => s.id)).toEqual([mine]);
    });

    it('totals a Session’s listed Tracks once each, however many genres they carry', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const track = { ownerUserId, generationRequestId: requestId, providerJobId: jobId };
      await createTrack(ctx.db, {
        ...track,
        genreTags: ['lofi', 'ambient', 'jazz'],
        durationSeconds: 125,
        audioStorageKey: 'test/three-genres.mp3',
      });
      await createTrack(ctx.db, {
        ...track,
        genreTags: [],
        durationSeconds: 65,
        audioStorageKey: 'test/no-genres.mp3',
      });
      await createTrack(ctx.db, {
        ...track,
        genreTags: ['techno'],
        durationSeconds: 999,
        dislikedAt: new Date('2026-07-16T12:00:00Z'),
      });

      const [item] = (await listResumableSessions(ctx.db, { ownerUserId, limit: 50 })).items;
      expect(item).toMatchObject({ trackCount: 2, totalDurationSeconds: 190 });
    });

    it('counts a listed Track of unknown length as 0, as a Playlist does', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const track = { ownerUserId, generationRequestId: requestId, providerJobId: jobId };
      await createTrack(ctx.db, {
        ...track,
        durationSeconds: 125,
        audioStorageKey: 'test/known.mp3',
      });
      await createTrack(ctx.db, {
        ...track,
        durationSeconds: null,
        audioStorageKey: 'test/unknown.mp3',
      });

      const [item] = (await listResumableSessions(ctx.db, { ownerUserId, limit: 50 })).items;
      expect(item).toMatchObject({ trackCount: 2, totalDurationSeconds: 125 });
    });

    it('summarizes owned Track activity for each Stopped Session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        genreTags: ['lofi', 'ambient'],
        audioStorageKey: 'test/lofi-ambient.mp3',
      });
      await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        genreTags: ['lofi', 'jazz'],
        audioStorageKey: 'test/lofi-jazz.mp3',
      });
      await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        genreTags: ['techno'],
        dislikedAt: new Date('2026-07-16T12:00:00Z'),
      });

      const [item] = (await listResumableSessions(ctx.db, { ownerUserId, limit: 50 })).items;
      expect(item).toMatchObject({
        id: sessionId,
        trackCount: 2,
        genreTags: ['lofi', 'ambient', 'jazz'],
      });
    });
  });

  describe('getSeedSnapshot (More Like This)', () => {
    it('returns kind=snapshot with the seed track’s session Style Snapshot', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        styleSnapshot: snapshot('seed vibe'),
      });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });

      const seed = await getSeedSnapshot(ctx.db, {
        viewerUserId: ownerUserId,
        seedTrackIds: [trackId],
      });
      expect(seed.kind).toBe('snapshot');
      if (seed.kind !== 'snapshot') throw new Error('unreachable');
      expect(seed.snapshot.stylePrompt).toBe('seed vibe');
      // An OWNED seed must never read as foreign — a wrong flag here would
      // strip the owner's Own Voice out of their own More Like This.
      expect(seed.foreignSeed).toBe(false);
    });

    // ADR 0017: the seed is the Track's FROZEN style. A later Change Vibe must
    // not leak into it — for a Lounge seed that later revision was never shared.
    it('seeds from the style that made the Track, not the Session’s later Change Vibe', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId,
        styleSnapshot: snapshot('lofi'),
      });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        styleRevision: 1,
        styleSnapshot: snapshot('lofi'),
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });
      const restyled = await restyleSession(ctx.db, {
        ownerUserId,
        sessionId,
        snapshot: snapshot('death metal'),
      });
      expect(restyled.ok).toBe(true);

      const seed = await getSeedSnapshot(ctx.db, {
        viewerUserId: ownerUserId,
        seedTrackIds: [trackId],
      });
      expect(seed.kind).toBe('snapshot');
      if (seed.kind !== 'snapshot') throw new Error('unreachable');
      expect(seed.snapshot.stylePrompt).toBe('lofi');
    });

    it('returns kind=no-readable-seed for a nonexistent seed track (no fallback, no session)', async () => {
      const ownerUserId = await createUser(ctx.db);
      const seed = await getSeedSnapshot(ctx.db, {
        viewerUserId: ownerUserId,
        seedTrackIds: ['00000000-0000-0000-0000-000000000000'],
      });
      expect(seed).toEqual({ kind: 'no-readable-seed' });
    });

    it('returns kind=no-readable-seed for another owner’s PRIVATE seed track', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId: otherId,
        styleSnapshot: snapshot('other vibe'),
      });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId: otherId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId: otherId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });

      const seed = await getSeedSnapshot(ctx.db, {
        viewerUserId: ownerUserId,
        seedTrackIds: [trackId],
      });
      expect(seed).toEqual({ kind: 'no-readable-seed' });
    });

    // The one read widening: a foreign seed resolves exactly while it
    // is Lounge-audible, and the result is MARKED foreign so the route strips the
    // owner's personal ingredients. Without the marker the sharer's Own Voice and
    // People notes would ride into the visitor's new session.
    it('resolves a FOREIGN Lounge-audible seed and marks it foreign', async () => {
      const sharerId = await createUser(ctx.db);
      const visitorId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId: sharerId,
        styleSnapshot: snapshot('shared vibe'),
      });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId: sharerId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId: sharerId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });
      const playlist = await createPlaylist(ctx.db, { ownerUserId: sharerId, name: 'Shelf' });
      await addPlaylistTracks(ctx.db, {
        ownerUserId: sharerId,
        playlistId: playlist.id,
        trackIds: [trackId],
      });
      await setPlaylistShared(ctx.db, {
        ownerUserId: sharerId,
        playlistId: playlist.id,
        audience: { kind: 'everyone' },
      });

      const seed = await getSeedSnapshot(ctx.db, {
        viewerUserId: visitorId,
        seedTrackIds: [trackId],
      });
      expect(seed.kind).toBe('snapshot');
      if (seed.kind !== 'snapshot') throw new Error('unreachable');
      expect(seed.snapshot.stylePrompt).toBe('shared vibe');
      expect(seed.foreignSeed).toBe(true);

      // Revoked = indistinguishable from never-existed (uniform 404 semantics).
      await setPlaylistShared(ctx.db, {
        ownerUserId: sharerId,
        playlistId: playlist.id,
        audience: null,
      });
      const revoked = await getSeedSnapshot(ctx.db, {
        viewerUserId: visitorId,
        seedTrackIds: [trackId],
      });
      expect(revoked).toEqual({ kind: 'no-readable-seed' });
    });

    it('returns kind=readable-no-snapshot for an owned seed whose session lacks a snapshot', async () => {
      const ownerUserId = await createUser(ctx.db);
      // Session created WITHOUT a style snapshot (fixture defaults it to null).
      const sessionId = await createSession(ctx.db, { ownerUserId });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });

      const seed = await getSeedSnapshot(ctx.db, {
        viewerUserId: ownerUserId,
        seedTrackIds: [trackId],
      });
      expect(seed).toEqual({ kind: 'readable-no-snapshot' });
    });
  });

  // The route-level gate that prevents a bogus/unowned seed from creating a session
  // and triggering PAID generation: it composes getSeedSnapshot's discriminated
  // result exactly as `POST /api/sessions/more-like-this` does.
  describe('moreLikeThis seed gating (BLOCKING #1)', () => {
    async function countSessions(ownerUserId: string): Promise<number> {
      const rows = await ctx.db
        .select({ id: activitySessions.id })
        .from(activitySessions)
        .where(eq(activitySessions.ownerUserId, ownerUserId));
      return rows.length;
    }

    // Mirror the route: no-readable-seed → reject (no session); otherwise reuse
    // the seed snapshot, or fall back to default controls for readable-no-snapshot.
    async function moreLikeThis(ownerUserId: string, seedTrackIds: string[]) {
      const seed = await getSeedSnapshot(ctx.db, { viewerUserId: ownerUserId, seedTrackIds });
      if (seed.kind === 'no-readable-seed')
        return { ok: false as const, reason: 'not_found' as const };
      const snap = seed.kind === 'snapshot' ? seed.snapshot : snapshot('default fallback');
      const created = await createSessionCmd(ctx.db, {
        ownerUserId,
        sessionMode: 'keep_going',
        snapshot: snap,
      });
      return { ok: true as const, sessionId: created.session.id };
    }

    it('rejects a nonexistent seed and creates NO session row', async () => {
      const ownerUserId = await createUser(ctx.db);
      const before = await countSessions(ownerUserId);
      const result = await moreLikeThis(ownerUserId, ['00000000-0000-0000-0000-000000000000']);
      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(await countSessions(ownerUserId)).toBe(before);
    });

    it('rejects another owner’s PRIVATE seed and creates NO session row', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, {
        ownerUserId: otherId,
        styleSnapshot: snapshot('other vibe'),
      });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId: otherId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId: otherId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });

      const before = await countSessions(ownerUserId);
      const result = await moreLikeThis(ownerUserId, [trackId]);
      expect(result.ok).toBe(false);
      expect(await countSessions(ownerUserId)).toBe(before);
    });

    it('creates a fallback session for an OWNED seed that lacks a snapshot', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });

      const result = await moreLikeThis(ownerUserId, [trackId]);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      const created = await readSession(ctx, result.sessionId);
      expect(created.status).toBe('active');
      expect(created.sessionStyleSnapshot?.stylePrompt).toBe('default fallback');
    });
  });

  describe('getSessionQueue + getSessionById', () => {
    /** The queue read with the two poll-time inputs the route injects: the
     *  shared phantom-submit bound and the music provider's tracks per call. */
    function readQueue(ownerUserId: string, sessionId: string) {
      return getSessionQueue(ctx.db, {
        ownerUserId,
        sessionId,
        phantomSubmitCutoff: new Date(Date.now() - PHANTOM_SUBMIT_MAX_AGE_MS),
        tracksPerRequest: 2,
      });
    }

    it('returns the ordered queue with resolved tracks for an owned session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'ready',
        audioStorageKey: 'audio/one.mp3',
      });
      await createQueueItem(ctx.db, { activitySessionId: sessionId, trackId, position: 0 });

      const view = await readQueue(ownerUserId, sessionId);
      expect(view).not.toBeNull();
      expect(view!.session.status).toBe('active');
      expect(view!.items).toHaveLength(1);
      expect(view!.items[0]!.track?.id).toBe(trackId);
      expect(view!.items[0]!.track?.status).toBe('ready');
      expect(view!.items[0]!.track?.hasPlayableAudio).toBe(true);
    });

    it('carries the blend identity from the slot request and the track analysis fields', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
        styleRevision: 2,
        targetBpm: 124,
        targetKey: 'A minor',
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'ready',
        audioStorageKey: 'audio/blend.mp3',
        streamEncryptedSourceUrl: 'enc:stream',
        analysisStatus: 'measured',
        analysisVersion: 1,
        bpmEstimate: 123.6,
        bpmSource: 'measured',
        bpmConfidence: 0.9,
        lufsIntegrated: -13.1,
        truePeakDb: -1.6,
      });
      // The queue slot carries no request edge of its own (trackId only): the
      // identity must resolve through the TRACK's request.
      await createQueueItem(ctx.db, { activitySessionId: sessionId, trackId, position: 0 });
      // A track-less generating slot resolves identity through its OWN request edge.
      await createQueueItem(ctx.db, {
        activitySessionId: sessionId,
        generationRequestId: requestId,
        position: 1,
        state: 'generating',
      });

      const view = await readQueue(ownerUserId, sessionId);
      const [withTrack, generating] = view!.items;
      expect(withTrack!.targetBpm).toBe(124);
      expect(withTrack!.targetKey).toBe('A minor');
      expect(withTrack!.styleRevision).toBe(2);
      expect(withTrack!.track?.hasFinalAsset).toBe(true);
      expect(withTrack!.track?.hasStreamAsset).toBe(true);
      expect(withTrack!.track?.analysis.analysisStatus).toBe('measured');
      expect(withTrack!.track?.analysis.bpmEstimate).toBeCloseTo(123.6);
      expect(generating!.targetBpm).toBe(124);
      expect(generating!.styleRevision).toBe(2);
      expect(generating!.track).toBeNull();
    });

    it('reports null identity for legacy requests', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'ready',
      });
      await createQueueItem(ctx.db, { activitySessionId: sessionId, trackId, position: 0 });

      const view = await readQueue(ownerUserId, sessionId);
      const item = view!.items[0]!;
      expect(item.targetBpm).toBeNull();
      expect(item.targetKey).toBeNull();
      expect(item.styleRevision).toBeNull();
      expect(item.track?.analysis.analysisStatus).toBe('pending');
      expect(item.track?.hasFinalAsset).toBe(false);
      expect(item.track?.hasStreamAsset).toBe(false);
    });

    it('getSessionById returns null for an unowned session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId: otherId });
      expect(await getSessionById(ctx.db, { ownerUserId, sessionId })).toBeNull();
    });

    // The windowed read: 30 slots of history behind the
    // current item stay in the read; older ones collapse into `earlier`.
    describe('windowed read', () => {
      /** N played slots then a playing current, its id stamped on the session. */
      async function seedLongSession(ownerUserId: string, playedCount: number) {
        const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
        for (let position = 0; position < playedCount; position += 1) {
          await createQueueItem(ctx.db, {
            activitySessionId: sessionId,
            position,
            state: 'played',
          });
        }
        const currentId = await createQueueItem(ctx.db, {
          activitySessionId: sessionId,
          position: playedCount,
          state: 'playing',
        });
        await ctx.pool.query(
          `update activity_sessions set current_queue_item_id = $1 where id = $2`,
          [currentId, sessionId],
        );
        return { sessionId, currentId };
      }

      it('returns the last 30 played slots + everything from the current item forward; `earlier` counts the rest', async () => {
        const ownerUserId = await createUser(ctx.db);
        const { sessionId, currentId } = await seedLongSession(ownerUserId, 35);
        await createQueueItem(ctx.db, {
          activitySessionId: sessionId,
          position: 36,
          state: 'queued',
        });

        const view = await readQueue(ownerUserId, sessionId);
        // Positions 0–4 elided; 5–34 (30 played) + current (35) + queued (36) stay.
        expect(view!.earlier).toBe(5);
        expect(view!.items.map((item) => item.position)).toEqual(
          Array.from({ length: 32 }, (_, index) => index + 5),
        );
        // The window is a suffix slice of the full order: elided + returned = all.
        expect(view!.earlier + view!.items.length).toBe(37);
        expect(view!.items.some((item) => item.id === currentId)).toBe(true);
        expect(view!.session.currentQueueItemId).toBe(currentId);
      });

      it('keeps the full order when the current item is near the head', async () => {
        const ownerUserId = await createUser(ctx.db);
        const { sessionId } = await seedLongSession(ownerUserId, 3);
        const view = await readQueue(ownerUserId, sessionId);
        expect(view!.earlier).toBe(0);
        expect(view!.items).toHaveLength(4);
      });

      it('counts the elided Tracks the player can play in `earlierTracks`', async () => {
        // The player numbers Tracks across the whole Session ("Track 41/43"),
        // so it needs the playable Tracks the window hid — the same ones its
        // own projection keeps: a slot with a pinned source, still in the
        // Session.
        const ownerUserId = await createUser(ctx.db);
        const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
        const slot = (position: number, playable: boolean) =>
          createQueueSlotAtRevision(ctx.db, {
            ownerUserId,
            activitySessionId: sessionId,
            styleRevision: 1,
            position,
            state: 'played',
            playable,
          });
        // 0–5 elided: three playable, one without audio, one deleted, one
        // trackless failed slot.
        await slot(0, true);
        await slot(1, true);
        await slot(2, false);
        await slot(3, true);
        const { trackId: deletedTrackId } = await slot(4, true);
        await deleteTrack(ctx.db, { ownerUserId, trackId: deletedTrackId });
        await createQueueItem(ctx.db, {
          activitySessionId: sessionId,
          position: 5,
          state: 'failed',
        });
        // 6–35: the window's 30 slots of history, then the current item.
        for (let position = 6; position < 36; position += 1) {
          await createQueueItem(ctx.db, {
            activitySessionId: sessionId,
            position,
            state: 'played',
          });
        }
        const currentId = await createQueueItem(ctx.db, {
          activitySessionId: sessionId,
          position: 36,
          state: 'playing',
        });
        await ctx.pool.query(
          `update activity_sessions set current_queue_item_id = $1 where id = $2`,
          [currentId, sessionId],
        );

        const view = await readQueue(ownerUserId, sessionId);
        expect(view!.items[0]!.position).toBe(6);
        expect(view!.earlierTracks).toBe(3);
      });

      it('elides no Tracks when the whole order fits the window', async () => {
        const ownerUserId = await createUser(ctx.db);
        const { sessionId } = await seedLongSession(ownerUserId, 3);
        expect((await readQueue(ownerUserId, sessionId))!.earlierTracks).toBe(0);
      });

      /** N consumed slots with no current item stamped on the session. */
      async function seedPointerlessSession(
        ownerUserId: string,
        consumed: number,
        state: 'played' | 'failed',
      ) {
        const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
        for (let position = 0; position < consumed; position += 1) {
          await createQueueItem(ctx.db, { activitySessionId: sessionId, position, state });
        }
        return sessionId;
      }

      it('windows on the first unconsumed slot when no current item is stamped', async () => {
        // A session whose playback never reported a start keeps a null pointer,
        // and the poll runs every 1–4s: without an anchor of its own the read
        // would drag the session's whole history each time.
        const ownerUserId = await createUser(ctx.db);
        const sessionId = await seedPointerlessSession(ownerUserId, 40, 'played');
        await createQueueItem(ctx.db, {
          activitySessionId: sessionId,
          position: 40,
          state: 'queued',
        });

        const view = await readQueue(ownerUserId, sessionId);
        // Positions 0–9 elided; the 30 slots before the queued one plus it stay.
        expect(view!.earlier).toBe(10);
        expect(view!.items.map((item) => item.position)).toEqual(
          Array.from({ length: 31 }, (_, index) => index + 10),
        );
      });

      it('windows on the tail when every slot is consumed and no current item is stamped', async () => {
        // No unconsumed slot to anchor on (every generation failed), which must
        // still bound the read rather than falling back to the full order.
        const ownerUserId = await createUser(ctx.db);
        const sessionId = await seedPointerlessSession(ownerUserId, 35, 'failed');

        const view = await readQueue(ownerUserId, sessionId);
        expect(view!.earlier).toBe(5);
        expect(view!.items.map((item) => item.position)).toEqual(
          Array.from({ length: 30 }, (_, index) => index + 5),
        );
      });

      it('keeps the full order for a fresh session with no current item', async () => {
        // The reachable null-pointer case: nothing has played, so nothing may be
        // elided — resume starts at the first playable item of what it reads.
        const ownerUserId = await createUser(ctx.db);
        const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
        for (let position = 0; position < 4; position += 1) {
          await createQueueItem(ctx.db, {
            activitySessionId: sessionId,
            position,
            state: 'queued',
          });
        }

        const view = await readQueue(ownerUserId, sessionId);
        expect(view!.earlier).toBe(0);
        expect(view!.items).toHaveLength(4);
      });
    });

    // A Dislike (reroll) removes the Track from the Session and flips its slot
    // to `rejected`. The row survives for retention, but every Queue surface
    // reads this view — so a returned or counted rejected slot resurrects the
    // removed Track on the next poll (and in every other tab).
    describe('rejected slots', () => {
      /** Slots at positions 0..n-1 in the given states, ids in that order. */
      async function seedSlots(sessionId: string, states: QueueItemState[]): Promise<string[]> {
        const ids: string[] = [];
        for (const [position, state] of states.entries()) {
          ids.push(
            await createQueueItem(ctx.db, { activitySessionId: sessionId, position, state }),
          );
        }
        return ids;
      }

      it('omits rejected slots from items and from the elided `earlier` count', async () => {
        const ownerUserId = await createUser(ctx.db);
        const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
        const states: QueueItemState[] = [
          // 0–4: four kept slots plus one removed, all outside the window.
          'played',
          'played',
          'rejected',
          'played',
          'played',
          // 5–34: the 30 kept slots of history the window holds.
          ...Array.from<QueueItemState>({ length: 30 }).fill('played'),
          'rejected', // 35–36: removed inside the window
          'rejected',
          'playing', // 37: the current item
          'rejected', // 38: removed ahead of the listener
          'queued', // 39
        ];
        const ids = await seedSlots(sessionId, states);
        await ctx.pool.query(
          `update activity_sessions set current_queue_item_id = $1 where id = $2`,
          [ids[37], sessionId],
        );

        const view = await readQueue(ownerUserId, sessionId);
        // Only the four kept slots at 0–4 fall outside the window of history.
        expect(view!.earlier).toBe(4);
        expect(view!.items.map((item) => item.position)).toEqual([
          ...Array.from({ length: 30 }, (_, index) => index + 5),
          37,
          39,
        ]);
      });

      it('drops the current slot itself once a Dislike rejects it', async () => {
        // Disliking the audible Track is the common path: the session pointer
        // still names its slot until playback advances.
        const ownerUserId = await createUser(ctx.db);
        const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
        const [played, current, queued] = await seedSlots(sessionId, [
          'played',
          'rejected',
          'queued',
        ]);
        await ctx.pool.query(
          `update activity_sessions set current_queue_item_id = $1 where id = $2`,
          [current, sessionId],
        );

        const view = await readQueue(ownerUserId, sessionId);
        expect(view!.items.map((item) => item.id)).toEqual([played, queued]);
        expect(view!.session.currentQueueItemId).toBe(current);
      });

      it('drops an already-played slot once its Track is Disliked or Deleted', async () => {
        // A Repeat lap, a Back, or the next Track's `started` landing first all
        // leave the removed Track's slot terminal `played`, which the state
        // machine never moves to `rejected` — the Track itself is what's gone.
        const ownerUserId = await createUser(ctx.db);
        const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
        const requestId = await createGenerationRequest(ctx.db, {
          ownerUserId,
          activitySessionId: sessionId,
        });
        const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
        const removedTrack = () =>
          createTrack(ctx.db, {
            ownerUserId,
            generationRequestId: requestId,
            providerJobId: jobId,
            audioStorageKey: `audio/${crypto.randomUUID()}.mp3`,
          });
        const [dislikedOld, deletedOld, dislikedRecent] = await Promise.all([
          removedTrack(),
          removedTrack(),
          removedTrack(),
        ]);
        // 0–1: removed slots outside the window; 2–31: thirty kept slots of
        // history; 32: removed inside the window; 33: current; 34: up next.
        const slotTracks = new Map([
          [0, dislikedOld],
          [1, deletedOld],
          [32, dislikedRecent],
        ]);
        const ids: string[] = [];
        for (let position = 0; position <= 34; position += 1) {
          ids.push(
            await createQueueItem(ctx.db, {
              activitySessionId: sessionId,
              trackId: slotTracks.get(position),
              position,
              state: position === 33 ? 'playing' : position === 34 ? 'queued' : 'played',
            }),
          );
        }
        await ctx.pool.query(
          `update activity_sessions set current_queue_item_id = $1 where id = $2`,
          [ids[33], sessionId],
        );

        await rejectDislikedTrack(ctx.db, {
          ownerUserId,
          trackId: dislikedOld,
          activitySessionId: sessionId,
        });
        await deleteTrack(ctx.db, { ownerUserId, trackId: deletedOld });
        await rejectDislikedTrack(ctx.db, {
          ownerUserId,
          trackId: dislikedRecent,
          activitySessionId: sessionId,
        });

        const view = await readQueue(ownerUserId, sessionId);
        expect(view!.earlier).toBe(0);
        expect(view!.items.map((item) => item.position)).toEqual([
          ...Array.from({ length: 30 }, (_, index) => index + 2),
          33,
          34,
        ]);
      });
    });

    // A queue slot is born `queued` when a provider track ARRIVES, so no slot
    // state ever says "Tracks are on the way": the band's generating count has
    // to come from the in-flight provider jobs themselves.
    describe('in-flight generation counts', () => {
      let ownerUserId: string;
      let sessionId: string;
      let nextPosition: number;

      beforeEach(async () => {
        ownerUserId = await createUser(ctx.db);
        sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
        nextPosition = 0;
      });

      /** One provider job for the session (live in-flight by default), with
       *  `arrived` of its Tracks already holding queue slots. */
      async function seedJob(
        opts: {
          arrived?: number;
          styleRevision?: number;
          normalizedStatus?: ProviderNormalizedStatus;
          submitState?: 'submit_unknown' | 'submit_rejected';
          updatedAt?: Date;
        } = {},
      ): Promise<void> {
        const generationRequestId = await createGenerationRequest(ctx.db, {
          ownerUserId,
          activitySessionId: sessionId,
          ...(opts.styleRevision === undefined ? {} : { styleRevision: opts.styleRevision }),
        });
        const providerJobId = await createProviderJob(ctx.db, {
          generationRequestId,
          normalizedStatus: opts.normalizedStatus ?? 'processing',
          ...(opts.submitState ? { submitState: opts.submitState, providerTaskId: null } : {}),
          ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
        });
        for (let arrived = 0; arrived < (opts.arrived ?? 0); arrived += 1) {
          const trackId = await createTrack(ctx.db, {
            ownerUserId,
            generationRequestId,
            providerJobId,
            status: 'ready',
          });
          nextPosition += 1;
          // Both edge arms, exactly as the provider-results writer stamps them.
          await createQueueItem(ctx.db, {
            activitySessionId: sessionId,
            trackId,
            generationRequestId,
            position: nextPosition,
          });
        }
      }

      it('counts the Tracks in-flight jobs still owe, netting out arrived siblings', async () => {
        await seedJob(); // nothing arrived yet → the full call, 2 Tracks
        await seedJob({ arrived: 1 }); // one sibling landed → 1 still coming
        await seedJob({ arrived: 2 }); // fully materialized → nothing owed

        expect((await readQueue(ownerUserId, sessionId))!.generatingTracksAhead).toBe(3);
      });

      it('never lets a job that over-delivered pull the count below zero', async () => {
        // A provider handing back more Tracks than its stated per-call figure
        // must not make the session owe negative Tracks: the count is a
        // non-negative contract field, so a negative fails the poll decode
        // outright and takes playback down with it.
        await seedJob({ arrived: 3 });

        expect((await readQueue(ownerUserId, sessionId))!.generatingTracksAhead).toBe(0);
      });

      it('ignores terminal jobs and phantom submits past the slot-hold bound', async () => {
        await seedJob({ normalizedStatus: 'ready' });
        await seedJob({ normalizedStatus: 'failed_final' });
        await seedJob({
          normalizedStatus: 'queued',
          updatedAt: new Date(Date.now() - PHANTOM_SUBMIT_MAX_AGE_MS - 60_000),
        });
        expect((await readQueue(ownerUserId, sessionId))!.generatingTracksAhead).toBe(0);

        // A young `queued` job may be mid-submit, so it still promises its Tracks.
        await seedJob({ normalizedStatus: 'queued' });
        expect((await readQueue(ownerUserId, sessionId))!.generatingTracksAhead).toBe(2);
      });

      it('promises no Tracks from a parked submit; only an uncertain one holds its buffer slot', async () => {
        // Nothing polls a job with no task id, so it can never deliver. The slot
        // hold stops a retry of an uncertain submit from paying twice; a refusal
        // charged nothing and its block signal stops the retry instead.
        await seedJob({ normalizedStatus: 'submit_unknown', submitState: 'submit_unknown' });
        await seedJob({ normalizedStatus: 'submit_rejected', submitState: 'submit_rejected' });

        const view = await readQueue(ownerUserId, sessionId);
        expect(view!.generatingTracksAhead).toBe(0);
        expect(view!.generatingNewVibeTracksAhead).toBe(0);
        expect(
          await countInFlightSessionJobs(ctx.db, {
            sessionId,
            phantomSubmitCutoff: new Date(Date.now() - PHANTOM_SUBMIT_MAX_AGE_MS),
          }),
        ).toBe(1);
      });

      it('scopes the new-vibe subset to the session’s live style revision', async () => {
        await ctx.pool.query(`update activity_sessions set style_revision = 2 where id = $1`, [
          sessionId,
        ]);
        await seedJob({ styleRevision: 1 });
        await seedJob({ styleRevision: 2 });

        const view = await readQueue(ownerUserId, sessionId);
        expect(view!.generatingTracksAhead).toBe(4);
        expect(view!.generatingNewVibeTracksAhead).toBe(2);
      });
    });

    it('projects the vibe facets without dragging the snapshot internals', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      await ctx.pool.query(
        `update activity_sessions set session_style_snapshot = $1 where id = $2`,
        [
          JSON.stringify({
            ...snapshot(),
            useOwnVoice: true,
            language: 'German',
            // Distinct values, because a misspelled key in the projection's
            // `jsonb_build_object` yields null — which an all-null expectation
            // would happily accept.
            styleStrength: 0.9,
            novelty: 0.05,
            userAvoid: 'saxophone',
          }),
          sessionId,
        ],
      );

      const view = await readQueue(ownerUserId, sessionId);
      expect(view!.session.styleFacets).toEqual({
        genreTags: ['lofi'],
        energy: 'low',
        vocalMode: 'instrumental',
        voiceGender: null,
        useOwnVoice: true,
        language: 'German',
        styleStrength: 0.9,
        novelty: 0.05,
        userAvoid: 'saxophone',
      });
      // The projection carries no snapshot internals (style prompt, seeds).
      expect(view!.session).not.toHaveProperty('sessionStyleSnapshot');
    });
  });

  describe('reportPlaybackState', () => {
    it('persists a started event and makes the reporter the active client', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });
      const queueItemId = await createQueueItem(ctx.db, {
        activitySessionId: sessionId,
        trackId,
        position: 0,
        state: 'playing',
      });

      const result = await reportPlaybackState(ctx.db, {
        ownerUserId,
        sessionId,
        clientId: 'device-1',
        clientEventId: '10000000-0000-0000-0000-000000000001',
        type: 'started',
        trackId,
        queueItemId,
        positionSeconds: 0,
        clientTimestamp: new Date('2026-06-20T10:00:00Z'),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.persistedEvent).toBe(true);
      expect(result.activePlaybackClientId).toBe('device-1');

      const events = await ctx.db
        .select()
        .from(playbackEvents)
        .where(eq(playbackEvents.activitySessionId, sessionId));
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe('started');

      // A valid in-session queue item + matching owned track is accepted and both
      // live pointers are updated (BLOCKING #3 accept path).
      const row = await readSession(ctx, sessionId);
      expect(row.activePlaybackClientId).toBe('device-1');
      expect(row.lastPlaybackReportAt).not.toBeNull();
      expect(row.currentTrackId).toBe(trackId);
      expect(row.currentQueueItemId).toBe(queueItemId);
    });

    it('returns null for an unowned session', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId: otherId, status: 'active' });
      const result = await reportPlaybackState(ctx.db, {
        ownerUserId,
        sessionId,
        clientId: 'device-1',
        clientEventId: '10000000-0000-0000-0000-000000000003',
        type: 'started',
        trackId: null,
        queueItemId: null,
        positionSeconds: null,
        clientTimestamp: new Date(),
      });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('dedupes a retried persisted event with the same clientEventId (exactly one row)', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const base = {
        ownerUserId,
        sessionId,
        clientId: 'device-1',
        clientEventId: '20000000-0000-0000-0000-000000000001',
        type: 'started' as const,
        trackId: null,
        queueItemId: null,
        positionSeconds: 0,
        clientTimestamp: new Date('2026-06-20T10:00:00Z'),
      };

      const first = await reportPlaybackState(ctx.db, base);
      const second = await reportPlaybackState(ctx.db, base);
      if (!first.ok || !second.ok) throw new Error('unreachable');

      const events = await ctx.db
        .select()
        .from(playbackEvents)
        .where(eq(playbackEvents.activitySessionId, sessionId));
      expect(events).toHaveLength(1);
      // The fresh report warrants a buffer top-up; the deduped retry warrants none.
      expect(first.bufferEnqueued).toBe(true);
      expect(second.bufferEnqueued).toBe(false);
    });

    it('rejects a queueItemId from a different session (no write) — BLOCKING #3', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      // A queue item that belongs to a DIFFERENT (owned) session.
      const otherSessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
      const foreignQueueItemId = await createQueueItem(ctx.db, {
        activitySessionId: otherSessionId,
        position: 0,
      });

      const result = await reportPlaybackState(ctx.db, {
        ownerUserId,
        sessionId,
        clientId: 'device-1',
        clientEventId: '30000000-0000-0000-0000-000000000001',
        type: 'started',
        trackId: null,
        queueItemId: foreignQueueItemId,
        positionSeconds: 0,
        clientTimestamp: new Date('2026-06-20T10:00:00Z'),
      });
      expect(result).toEqual({ ok: false, reason: 'invalid_reference' });

      const events = await ctx.db
        .select()
        .from(playbackEvents)
        .where(eq(playbackEvents.activitySessionId, sessionId));
      expect(events).toHaveLength(0);
      const row = await readSession(ctx, sessionId);
      expect(row.currentQueueItemId).toBeNull();
      expect(row.activePlaybackClientId).toBeNull();
    });

    it('rejects a trackId owned by a different user (no write) — BLOCKING #3', async () => {
      const ownerUserId = await createUser(ctx.db);
      const otherId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      // A track owned by someone else.
      const otherSessionId = await createSession(ctx.db, { ownerUserId: otherId });
      const otherRequestId = await createGenerationRequest(ctx.db, {
        ownerUserId: otherId,
        activitySessionId: otherSessionId,
      });
      const otherJobId = await createProviderJob(ctx.db, { generationRequestId: otherRequestId });
      const foreignTrackId = await createTrack(ctx.db, {
        ownerUserId: otherId,
        generationRequestId: otherRequestId,
        providerJobId: otherJobId,
      });

      const result = await reportPlaybackState(ctx.db, {
        ownerUserId,
        sessionId,
        clientId: 'device-1',
        clientEventId: '30000000-0000-0000-0000-000000000002',
        type: 'started',
        trackId: foreignTrackId,
        queueItemId: null,
        positionSeconds: 0,
        clientTimestamp: new Date('2026-06-20T10:00:00Z'),
      });
      expect(result).toEqual({ ok: false, reason: 'invalid_reference' });

      const events = await ctx.db
        .select()
        .from(playbackEvents)
        .where(eq(playbackEvents.activitySessionId, sessionId));
      expect(events).toHaveLength(0);
      expect((await readSession(ctx, sessionId)).currentTrackId).toBeNull();
    });

    it('rejects a trackId that does not match the queue item (no write) — BLOCKING #3', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      // The queue item carries trackA; the report claims a different owned trackB.
      const trackA = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });
      const trackB = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });
      const queueItemId = await createQueueItem(ctx.db, {
        activitySessionId: sessionId,
        trackId: trackA,
        position: 0,
        state: 'playing',
      });

      const result = await reportPlaybackState(ctx.db, {
        ownerUserId,
        sessionId,
        clientId: 'device-1',
        clientEventId: '30000000-0000-0000-0000-000000000003',
        type: 'started',
        trackId: trackB,
        queueItemId,
        positionSeconds: 0,
        clientTimestamp: new Date('2026-06-20T10:00:00Z'),
      });
      expect(result).toEqual({ ok: false, reason: 'invalid_reference' });

      const events = await ctx.db
        .select()
        .from(playbackEvents)
        .where(eq(playbackEvents.activitySessionId, sessionId));
      expect(events).toHaveLength(0);
    });

    it('a delayed retry (same clientEventId) leaves live fields UNCHANGED — BLOCKING', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const trackId = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
      });
      const queueItemId = await createQueueItem(ctx.db, {
        activitySessionId: sessionId,
        trackId,
        position: 0,
        state: 'playing',
      });

      const clientEventId = '40000000-0000-0000-0000-000000000001';
      const firstNow = new Date('2026-06-20T10:00:00Z');
      const first = await reportPlaybackState(ctx.db, {
        ownerUserId,
        sessionId,
        clientId: 'device-A',
        clientEventId,
        type: 'started',
        trackId,
        queueItemId,
        positionSeconds: 0,
        clientTimestamp: firstNow,
        now: firstNow,
      });
      expect(first.ok).toBe(true);

      const afterFirst = await readSession(ctx, sessionId);
      expect(afterFirst.activePlaybackClientId).toBe('device-A');
      expect(afterFirst.currentTrackId).toBe(trackId);
      expect(afterFirst.currentQueueItemId).toBe(queueItemId);
      const firstReportAt = afterFirst.lastPlaybackReportAt;
      expect(firstReportAt).not.toBeNull();

      // A delayed retry of the SAME logical event: same clientEventId, a different
      // controller, a later clock, a bogus position — it must dedupe AND touch
      // nothing (no reclaim, no recency refresh that would reset idle/eviction).
      const retryNow = new Date('2026-06-20T10:05:00Z');
      const retry = await reportPlaybackState(ctx.db, {
        ownerUserId,
        sessionId,
        clientId: 'device-B',
        clientEventId,
        type: 'started',
        trackId: null,
        queueItemId: null,
        positionSeconds: 999,
        clientTimestamp: retryNow,
        now: retryNow,
      });
      expect(retry.ok).toBe(true);
      if (!retry.ok) throw new Error('unreachable');
      expect(retry.bufferEnqueued).toBe(false);

      // Exactly one persisted row.
      const events = await ctx.db
        .select()
        .from(playbackEvents)
        .where(eq(playbackEvents.activitySessionId, sessionId));
      expect(events).toHaveLength(1);

      // Every live field is exactly as the original landing left it.
      const afterRetry = await readSession(ctx, sessionId);
      expect(afterRetry.activePlaybackClientId).toBe('device-A');
      expect(afterRetry.currentTrackId).toBe(trackId);
      expect(afterRetry.currentQueueItemId).toBe(queueItemId);
      expect(afterRetry.lastPlaybackPositionSeconds).toBe(0);
      expect(afterRetry.lastPlaybackReportAt?.getTime()).toBe(firstReportAt?.getTime());
    });

    it('a fresh persisted event (new clientEventId) DOES update live fields and inserts a row', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });

      const firstNow = new Date('2026-06-20T10:00:00Z');
      await reportPlaybackState(ctx.db, {
        ownerUserId,
        sessionId,
        clientId: 'device-A',
        clientEventId: '40000000-0000-0000-0000-000000000010',
        type: 'started',
        trackId: null,
        queueItemId: null,
        positionSeconds: 5,
        clientTimestamp: firstNow,
        now: firstNow,
      });
      const afterFirst = await readSession(ctx, sessionId);

      // A DISTINCT clientEventId is a different logical event: it lands, refreshes the
      // live fields, and inserts a second row.
      const secondNow = new Date('2026-06-20T10:03:00Z');
      const result = await reportPlaybackState(ctx.db, {
        ownerUserId,
        sessionId,
        clientId: 'device-B',
        clientEventId: '40000000-0000-0000-0000-000000000011',
        type: 'ended',
        trackId: null,
        queueItemId: null,
        positionSeconds: 42,
        clientTimestamp: secondNow,
        now: secondNow,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.bufferEnqueued).toBe(true);

      const events = await ctx.db
        .select()
        .from(playbackEvents)
        .where(eq(playbackEvents.activitySessionId, sessionId));
      expect(events).toHaveLength(2);

      const afterSecond = await readSession(ctx, sessionId);
      expect(afterSecond.activePlaybackClientId).toBe('device-B');
      expect(afterSecond.lastPlaybackPositionSeconds).toBe(42);
      expect(afterSecond.lastPlaybackReportAt?.getTime()).toBe(secondNow.getTime());
      expect(afterSecond.lastPlaybackReportAt?.getTime()).not.toBe(
        afterFirst.lastPlaybackReportAt?.getTime(),
      );
    });

    it('a position ping updates live fields and persists no row', async () => {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });

      const pingNow = new Date('2026-06-20T10:00:30Z');
      const result = await reportPlaybackState(ctx.db, {
        ownerUserId,
        sessionId,
        clientId: 'device-A',
        clientEventId: '40000000-0000-0000-0000-000000000020',
        type: 'position',
        trackId: null,
        queueItemId: null,
        positionSeconds: 17.5,
        clientTimestamp: pingNow,
        now: pingNow,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.persistedEvent).toBe(false);

      const events = await ctx.db
        .select()
        .from(playbackEvents)
        .where(eq(playbackEvents.activitySessionId, sessionId));
      expect(events).toHaveLength(0);

      const row = await readSession(ctx, sessionId);
      expect(row.lastPlaybackPositionSeconds).toBe(17.5);
      expect(row.activePlaybackClientId).toBe('device-A');
      expect(row.lastPlaybackReportAt?.getTime()).toBe(pingNow.getTime());
    });
  });

  describe('reportPlaybackState — queue-item lifecycle', () => {
    /** An active session with `n` tracks buffered as `queued` items at positions 0..n-1. */
    async function seedQueuedSession(n: number) {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId, status: 'active' });
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const items: { queueItemId: string; trackId: string }[] = [];
      for (let position = 0; position < n; position += 1) {
        const trackId = await createTrack(ctx.db, {
          ownerUserId,
          generationRequestId: requestId,
          providerJobId: jobId,
        });
        const queueItemId = await createQueueItem(ctx.db, {
          activitySessionId: sessionId,
          trackId,
          position,
        });
        items.push({ queueItemId, trackId });
      }
      return { ownerUserId, sessionId, items };
    }

    let eventCounter = 0;
    /** A fresh persisted report against one queue item (unique clientEventId per call). */
    function report(
      seed: { ownerUserId: string; sessionId: string },
      type: 'started' | 'ended' | 'skipped' | 'failed',
      item: { queueItemId: string | null; trackId: string },
      clientEventId?: string,
      options: { shuffled?: boolean } = {},
    ) {
      eventCounter += 1;
      return reportPlaybackState(ctx.db, {
        ownerUserId: seed.ownerUserId,
        sessionId: seed.sessionId,
        clientId: 'device-1',
        clientEventId:
          clientEventId ?? `50000000-0000-0000-0000-${String(eventCounter).padStart(12, '0')}`,
        type,
        trackId: item.trackId,
        queueItemId: item.queueItemId,
        positionSeconds: 0,
        clientTimestamp: new Date('2026-06-20T10:00:00Z'),
        ...options,
      });
    }

    async function stateOf(queueItemId: string): Promise<string> {
      const [row] = await ctx.db
        .select({ state: activitySessionQueueItems.state })
        .from(activitySessionQueueItems)
        .where(eq(activitySessionQueueItems.id, queueItemId));
      return row!.state;
    }

    it('started moves the reported item queued → playing; ended completes it as played', async () => {
      const seed = await seedQueuedSession(1);
      const [item] = seed.items;

      await report(seed, 'started', item!);
      expect(await stateOf(item!.queueItemId)).toBe('playing');

      await report(seed, 'ended', item!);
      expect(await stateOf(item!.queueItemId)).toBe('played');
    });

    it('skipped and failed map the reported item to the matching terminal state', async () => {
      const seed = await seedQueuedSession(2);
      const [first, second] = seed.items;

      await report(seed, 'skipped', first!); // skipped straight from `queued`
      expect(await stateOf(first!.queueItemId)).toBe('skipped');

      await report(seed, 'started', second!);
      await report(seed, 'failed', second!); // failed from `playing`
      expect(await stateOf(second!.queueItemId)).toBe('failed');
    });

    it('the next started closes out a previous item left playing (lost ended report)', async () => {
      const seed = await seedQueuedSession(2);
      const [first, second] = seed.items;

      await report(seed, 'started', first!);
      // The `ended` report for the first item never arrives; the next start heals it.
      await report(seed, 'started', second!);

      expect(await stateOf(first!.queueItemId)).toBe('played');
      expect(await stateOf(second!.queueItemId)).toBe('playing');
    });

    it('started marks earlier still-queued items skipped (lost skip reports)', async () => {
      const seed = await seedQueuedSession(3);
      const [first, second, third] = seed.items;

      // Skips of items 0 and 1 were lost; playback starts at position 2.
      await report(seed, 'started', third!);

      expect(await stateOf(first!.queueItemId)).toBe('skipped');
      expect(await stateOf(second!.queueItemId)).toBe('skipped');
      expect(await stateOf(third!.queueItemId)).toBe('playing');
    });

    it('a shuffled started leaves earlier unheard items queued, so ready-ahead holds', async () => {
      const seed = await seedQueuedSession(4);
      const [first, second, third, fourth] = seed.items;

      // Shuffle jumps from position 0 to position 3; positions 1–2 are still unheard.
      await report(seed, 'started', first!, undefined, { shuffled: true });
      await report(seed, 'ended', first!);
      await report(seed, 'started', fourth!, undefined, { shuffled: true });

      expect(await stateOf(second!.queueItemId)).toBe('queued');
      expect(await stateOf(third!.queueItemId)).toBe('queued');
      expect(await stateOf(fourth!.queueItemId)).toBe('playing');
      expect(await countReadyAheadTracks(ctx.db, seed.sessionId)).toBe(2);
    });

    it('ended completes an item straight from queued (lost started report)', async () => {
      const seed = await seedQueuedSession(1);
      const [item] = seed.items;

      await report(seed, 'ended', item!);
      expect(await stateOf(item!.queueItemId)).toBe('played');
    });

    it('a deduped retry never re-applies a transition', async () => {
      const seed = await seedQueuedSession(1);
      const [item] = seed.items;
      const startedEventId = '50000000-0000-0000-0000-00000000dead';

      await report(seed, 'started', item!, startedEventId);
      await report(seed, 'ended', item!);
      // A delayed retry of the original `started` must not drag the item back.
      await report(seed, 'started', item!, startedEventId);

      expect(await stateOf(item!.queueItemId)).toBe('played');
    });

    it('a stale out-of-order started for an earlier item never touches the current one', async () => {
      const seed = await seedQueuedSession(2);
      const [first, second] = seed.items;

      // Track 0's `started` is delayed on the network; track 1's lands first.
      await report(seed, 'started', second!);
      // The delayed track-0 report now lands for the FIRST time (fresh, not deduped).
      await report(seed, 'started', first!);

      // The current item must stay `playing`; the stale report heals nothing forward.
      expect(await stateOf(second!.queueItemId)).toBe('playing');
      expect(await stateOf(first!.queueItemId)).toBe('skipped');
    });

    it('a track-only report (queueItemId null) still advances the queue slot', async () => {
      const seed = await seedQueuedSession(1);
      const [item] = seed.items;
      const trackOnly = { queueItemId: null, trackId: item!.trackId };

      await report(seed, 'started', trackOnly);
      expect(await stateOf(item!.queueItemId)).toBe('playing');
      // Both cursor pointers move together: the resolved slot fills currentQueueItemId
      // even though the report carried no queueItemId.
      const row = await readSession(ctx, seed.sessionId);
      expect(row.currentTrackId).toBe(item!.trackId);
      expect(row.currentQueueItemId).toBe(item!.queueItemId);

      await report(seed, 'ended', trackOnly);
      expect(await stateOf(item!.queueItemId)).toBe('played');
    });

    it('a track-only report for a non-queued track (library stand-in) lands and transitions nothing', async () => {
      const seed = await seedQueuedSession(1);
      const [item] = seed.items;
      // An owned track that is NOT in this session's queue (a cold-start stand-in).
      const standIn = await seedReadyTrack(ctx.db, {
        ownerUserId: seed.ownerUserId,
        sessionId: seed.sessionId,
      });
      // seedReadyTrack creates no queue item, so this is a pure track-only report.
      const result = await report(seed, 'started', {
        queueItemId: null,
        trackId: standIn.trackId,
      });

      expect(result.ok).toBe(true);
      expect(await stateOf(item!.queueItemId)).toBe('queued');
    });

    it('a terminal item (e.g. rejected by dislike) is never moved by a report', async () => {
      const seed = await seedQueuedSession(1);
      const [item] = seed.items;
      await ctx.db
        .update(activitySessionQueueItems)
        .set({ state: 'rejected' })
        .where(eq(activitySessionQueueItems.id, item!.queueItemId));

      await report(seed, 'started', item!);
      expect(await stateOf(item!.queueItemId)).toBe('rejected');
    });

    it('played tracks stop counting as ready-ahead, so the buffer refills', async () => {
      // The core-loop regression: 2 buffered tracks play out; with the low watermark
      // at the default 2, the buffer controller must see the queue as EMPTY again
      // (readyAhead 0 < watermark) so the session keeps generating.
      const seed = await seedQueuedSession(2);
      const [first, second] = seed.items;
      expect(await countReadyAheadTracks(ctx.db, seed.sessionId)).toBe(2);

      await report(seed, 'started', first!);
      expect(await countReadyAheadTracks(ctx.db, seed.sessionId)).toBe(1);

      await report(seed, 'ended', first!);
      await report(seed, 'started', second!);
      await report(seed, 'ended', second!);
      expect(await countReadyAheadTracks(ctx.db, seed.sessionId)).toBe(0);
    });
  });
});
