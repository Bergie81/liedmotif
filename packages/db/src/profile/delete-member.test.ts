// Deleting a Member without stranding bytes or spend history.
// The whole operation is ONE transaction: enqueue every storage key, let the
// user cascade run, then reclaim the now-unreferenced covers. The spend ledger
// (generation_requests / provider_jobs / the cover ledger) survives with a null
// owner and keeps counting in the Members Pool until the window rolls over.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createCoverImage,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
} from '../generation/test-fixtures';
import {
  activitySessions,
  APP_SETTINGS_KEYS,
  coverImages,
  deletionQueueItems,
  generationOutputs,
  generationRequests,
  invites,
  people,
  personReferencePhotos,
  providerJobs,
  sessionCoverGenerations,
  emptySessionCoverPlan,
  SESSION_COVER_LIVE_STATES,
  trackAudioAssets,
  tracks,
  user,
  userProfiles,
} from '../schema';
import { getCostComparison } from '../analytics/cost-repo';
import { getCachedListeningStats, recordListening } from '../analytics/listening-repo';
import { createPlaylist, setTrackFavorited } from '../playlists/playlists-repo';
import { getPlaylistShare, setPlaylistShared } from '../playlists/playlist-share-repo';
import { isPlaylistLoungePinned, setPlaylistLoungePinned } from '../playlists/pins-repo';
import { countTasksInWindow } from '../generation/limits-repo';
import { planSessionCoverGeneration } from '../covers/generation-ledger-repo';
import { countCoverSpendSince } from '../covers/usage';
import { writeSetting } from '../setup/settings';
import { POOL_SCOPE } from '../member-pool';
import { deleteMember } from './delete-member';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const WINDOW_START = new Date('2020-01-01T00:00:00Z');

describeIfDb('deleteMember', () => {
  let ctx: TestDb;
  let adminId: string;
  let memberId: string;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-delete-member-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [...GENERATION_FIXTURE_TABLES, 'people', 'invites']);
    await ctx.db.delete(coverImages).where(eq(coverImages.sourceType, 'generated'));
    adminId = await createUser(ctx.db);
    memberId = await createUser(ctx.db);
    await ctx.db.insert(userProfiles).values([
      { userId: adminId, role: 'admin' },
      { userId: memberId, role: 'member' },
    ]);
  });

  /** A member session with one generated track (audio asset) and a session cover. */
  async function seedMemberContent() {
    const sessionId = await createSession(ctx.db, { ownerUserId: memberId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId: memberId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const trackId = await createTrack(ctx.db, {
      ownerUserId: memberId,
      generationRequestId: requestId,
      providerJobId: jobId,
    });
    await ctx.db.insert(trackAudioAssets).values({
      trackId,
      assetType: 'local_original',
      storageProvider: 'local-fs',
      storageKey: `tracks/${memberId}/original.mp3`,
      byteSize: 1_000,
      isPlayable: true,
    });
    const coverImageId = await createCoverImage(ctx.db);
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId })
      .where(eq(activitySessions.id, sessionId));

    const [person] = await ctx.db
      .insert(people)
      .values({
        ownerUserId: memberId,
        role: 'ordinary',
        name: 'Nana',
        nameMatchKey: 'nana',
        sortOrder: 1,
      })
      .returning();
    await ctx.db.insert(personReferencePhotos).values({
      ownerUserId: memberId,
      personId: person!.id,
      storageProvider: 'local-fs',
      storageKey: `person-references/${memberId}/photo.webp`,
      mediaType: 'image/webp',
      byteSize: 500,
    });

    return { sessionId, requestId, jobId, trackId, coverImageId };
  }

  async function queuedKeys(): Promise<string[]> {
    const rows = await ctx.db
      .select({ storageKey: deletionQueueItems.storageKey })
      .from(deletionQueueItems);
    return rows.map((row) => row.storageKey!).sort();
  }

  it('enqueues every storage key, removes every row, and keeps the spend ledger counting', async () => {
    const seeded = await seedMemberContent();
    const [coverRow] = await ctx.db
      .select()
      .from(coverImages)
      .where(eq(coverImages.id, seeded.coverImageId));

    const poolBefore = await countTasksInWindow(ctx.db, { scope: POOL_SCOPE, since: WINDOW_START });
    expect(poolBefore).toBeGreaterThan(0);

    const result = await deleteMember(ctx.db, {
      userId: memberId,
      avatarStorageKey: `avatars/${memberId}/a1.webp`,
    });
    expect(result).toEqual({ ok: true, trackCount: 1, reclaimedCoverCount: 1 });

    // Every byte the Member owned is queued: audio, cover original + rendition,
    // person photo, avatar.
    expect(await queuedKeys()).toEqual(
      [
        `tracks/${memberId}/original.mp3`,
        coverRow!.storageKey,
        `covers/renditions/${seeded.coverImageId}-w160.webp`,
        `person-references/${memberId}/photo.webp`,
        `avatars/${memberId}/a1.webp`,
      ].sort(),
    );

    // The rows are gone — user, profile, content.
    expect(await ctx.db.select().from(user).where(eq(user.id, memberId))).toHaveLength(0);
    expect(await ctx.db.select().from(tracks)).toHaveLength(0);
    expect(await ctx.db.select().from(activitySessions)).toHaveLength(0);
    expect(
      await ctx.db.select().from(coverImages).where(eq(coverImages.id, seeded.coverImageId)),
    ).toHaveLength(0);

    // The spend ledger survives ownerless and the Pool count does not move.
    const [request] = await ctx.db
      .select()
      .from(generationRequests)
      .where(eq(generationRequests.id, seeded.requestId));
    expect(request).toBeDefined();
    expect(request!.ownerUserId).toBeNull();
    expect(
      await ctx.db.select().from(providerJobs).where(eq(providerJobs.id, seeded.jobId)),
    ).toHaveLength(1);
    expect(await countTasksInWindow(ctx.db, { scope: POOL_SCOPE, since: WINDOW_START })).toBe(
      poolBefore,
    );
  });

  /** A cover ledger attempt whose plan carries the Member's private art direction. */
  async function seedCoverAttempt(args: {
    activitySessionId: string;
    state: 'ready' | 'submitting' | 'reserved';
    possiblyPaid: boolean;
    coverImageId?: string;
  }) {
    const id = randomUUID();
    await planSessionCoverGeneration(ctx.db, {
      id,
      ownerUserId: memberId,
      activitySessionId: args.activitySessionId,
      plan: emptySessionCoverPlan({
        sessionName: 'Nana birthday mix',
        customDefinition: 'private custom style',
        concreteScene: 'private scene',
        selectedPersonIds: [randomUUID()],
        userGuidance: 'private guidance',
        effectiveGuidance: 'private enhanced guidance',
        prompt: 'private prompt',
        altText: 'private alt text',
      }),
      planVersion: 'test-plan',
      promptVersion: 'test-prompt',
      planHash: `plan-${id}`,
      promptHash: `prompt-${id}`,
      fingerprint: { scene: 'private scene', customStyle: 'private custom style' },
      providerKey: 'test-provider',
      model: 'test-model',
      capabilitySnapshot: {},
      idempotencyKey: `cover-${id}`,
      retryPolicy: {},
      selectedReferences: [{ id: randomUUID(), role: 'subject', personId: randomUUID() }],
      seed: 'private-seed',
      coverImageId: args.coverImageId ?? randomUUID(),
      storageKey: `covers/${id}.webp`,
      initialState: args.state,
    });
    await ctx.db
      .update(sessionCoverGenerations)
      .set({
        possiblyPaid: args.possiblyPaid,
        submittedAt: args.possiblyPaid ? new Date() : null,
      })
      .where(eq(sessionCoverGenerations.id, id));
    return id;
  }

  it("keeps the Member's cover spend counting in the Pool with nothing private left", async () => {
    const seeded = await seedMemberContent();
    await seedCoverAttempt({
      activitySessionId: seeded.sessionId,
      state: 'ready',
      possiblyPaid: true,
      coverImageId: seeded.coverImageId,
    });
    const inFlightSessionId = await createSession(ctx.db, {
      ownerUserId: memberId,
      status: 'stopped',
    });
    await seedCoverAttempt({
      activitySessionId: inFlightSessionId,
      state: 'submitting',
      possiblyPaid: true,
    });
    const unsubmittedSessionId = await createSession(ctx.db, {
      ownerUserId: memberId,
      status: 'stopped',
    });
    await seedCoverAttempt({
      activitySessionId: unsubmittedSessionId,
      state: 'reserved',
      possiblyPaid: false,
    });
    const paidCovers = () =>
      countCoverSpendSince(ctx.db, { scope: POOL_SCOPE, since: WINDOW_START });
    expect(await paidCovers()).toBe(3);

    const result = await deleteMember(ctx.db, { userId: memberId });
    // A ledger row naming the cover does not keep a deleted Member's bytes alive.
    expect(result).toMatchObject({ ok: true, reclaimedCoverCount: 1 });

    // The two attempts that reached the provider keep counting; the reservation
    // that never submitted moved no money and stops holding a slot.
    expect(await paidCovers()).toBe(2);
    // Stats → Costs shows the same surviving spend under Former members.
    const costs = await getCostComparison(ctx.db, { adminUserId: adminId, since: WINDOW_START });
    expect(costs.formerMembers.covers).toBe(2);

    const rows = await ctx.db.select().from(sessionCoverGenerations);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.ownerUserId).toBeNull();
      expect(row.activitySessionId).toBeNull();
      expect(row.playlistId).toBeNull();
      expect(SESSION_COVER_LIVE_STATES).not.toContain(row.state);
      expect(row.plan).toEqual(emptySessionCoverPlan());
      expect(row.fingerprint).toEqual({});
      expect(row.selectedReferences).toEqual([]);
      expect(row.seed).toBeNull();
    }
    expect(JSON.stringify(rows)).not.toMatch(/private|Nana/);
  });

  it("counts a deleted Member's cover once when something else keeps the image", async () => {
    // An instance with pre-ledger history still runs the legacy cover count,
    // whose anti-join must keep recognising the ownerless ledger row.
    await writeSetting(ctx.db, APP_SETTINGS_KEYS.legacyGeneratedCoversExhausted, false);
    const seeded = await seedMemberContent();
    await ctx.db
      .update(coverImages)
      .set({ provenance: { ownerUserId: memberId } })
      .where(eq(coverImages.id, seeded.coverImageId));
    await seedCoverAttempt({
      activitySessionId: seeded.sessionId,
      state: 'ready',
      possiblyPaid: true,
      coverImageId: seeded.coverImageId,
    });
    const adminSessionId = await createSession(ctx.db, { ownerUserId: adminId });
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId: seeded.coverImageId })
      .where(eq(activitySessions.id, adminSessionId));
    const poolCovers = () =>
      countCoverSpendSince(ctx.db, { scope: POOL_SCOPE, since: WINDOW_START });
    expect(await poolCovers()).toBe(1);

    expect(await deleteMember(ctx.db, { userId: memberId })).toMatchObject({
      ok: true,
      reclaimedCoverCount: 0,
    });

    expect(await poolCovers()).toBe(1);
  });

  it('removes personal analytics with the Member and leaves the spend ledger counting', async () => {
    const seeded = await seedMemberContent();
    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, seeded.trackId));
    await ctx.db.insert(generationOutputs).values({
      ownerUserId: memberId,
      analyticsTrackId: track!.analyticsId,
      trackId: seeded.trackId,
    });
    const now = new Date();
    await recordListening(ctx.db, {
      ownerUserId: memberId,
      occurrenceId: '00000000-0000-4000-a000-000000000001',
      trackId: seeded.trackId,
      sessionId: seeded.sessionId,
      surface: 'session',
      startedAt: new Date(now.getTime() - 40_000),
      listenedMs: 40_000,
      playedMs: 40_000,
      origin: 'auto',
      clientTimestamp: now,
      endReason: null,
      now,
    });
    await getCachedListeningStats(ctx.db, {
      ownerUserId: memberId,
      range: 'all',
      now,
      timezone: 'UTC',
    });
    await setTrackFavorited(ctx.db, {
      ownerUserId: memberId,
      trackId: seeded.trackId,
      favorited: true,
    });
    const learned = await ctx.pool.query(`select count(*)::int as n from taste_evidence`);
    expect(learned.rows[0].n).toBe(1);
    const poolBefore = await countTasksInWindow(ctx.db, { scope: POOL_SCOPE, since: WINDOW_START });

    expect(await deleteMember(ctx.db, { userId: memberId })).toMatchObject({ ok: true });

    const left = await ctx.pool.query(
      `select (select count(*) from listening_occurrences)::int as listening,
              (select count(*) from listening_preferences)::int as preferences,
              (select count(*) from generation_outputs)::int as outputs,
              (select count(*) from taste_evidence)::int as taste,
              (select count(*) from user_settings where owner_user_id = $1)::int as settings`,
      [memberId],
    );
    expect(left.rows[0]).toEqual({
      listening: 0,
      preferences: 0,
      outputs: 0,
      taste: 0,
      settings: 0,
    });
    expect(await countTasksInWindow(ctx.db, { scope: POOL_SCOPE, since: WINDOW_START })).toBe(
      poolBefore,
    );
  });

  it('never reclaims a cover something else still references', async () => {
    const seeded = await seedMemberContent();
    // The Admin's session points at the SAME cover image.
    const adminSessionId = await createSession(ctx.db, { ownerUserId: adminId });
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId: seeded.coverImageId })
      .where(eq(activitySessions.id, adminSessionId));

    const result = await deleteMember(ctx.db, { userId: memberId });
    expect(result).toMatchObject({ ok: true, reclaimedCoverCount: 0 });
    expect(
      await ctx.db.select().from(coverImages).where(eq(coverImages.id, seeded.coverImageId)),
    ).toHaveLength(1);
    expect(await queuedKeys()).not.toContain(seeded.coverImageId);
  });

  it('keeps the consumed invite as audit trail with a nulled consumer', async () => {
    await seedMemberContent();
    const [invite] = await ctx.db
      .insert(invites)
      .values({
        kind: 'member_invite',
        label: 'Lisa',
        tokenHash: 'hash',
        createdByUserId: adminId,
        expiresAt: new Date(Date.now() + 1_000_000),
        consumedAt: new Date(),
        consumedByUserId: memberId,
      })
      .returning();

    expect((await deleteMember(ctx.db, { userId: memberId })).ok).toBe(true);

    const [survivor] = await ctx.db.select().from(invites).where(eq(invites.id, invite!.id));
    expect(survivor).toBeDefined();
    expect(survivor!.label).toBe('Lisa');
    expect(survivor!.consumedByUserId).toBeNull();
    expect(survivor!.consumedAt).not.toBeNull();
  });

  it('refuses the Admin and unknown users', async () => {
    expect(await deleteMember(ctx.db, { userId: adminId })).toEqual({
      ok: false,
      reason: 'not_member',
    });
    expect(await deleteMember(ctx.db, { userId: 'nobody' })).toEqual({
      ok: false,
      reason: 'not_member',
    });
    expect(await ctx.db.select().from(user).where(eq(user.id, adminId))).toHaveLength(1);
  });

  it('is idempotent: a second delete finds no member and changes nothing', async () => {
    await seedMemberContent();
    expect((await deleteMember(ctx.db, { userId: memberId })).ok).toBe(true);
    const keysAfterFirst = await queuedKeys();
    expect(await deleteMember(ctx.db, { userId: memberId })).toEqual({
      ok: false,
      reason: 'not_member',
    });
    expect(await queuedKeys()).toEqual(keysAfterFirst);
  });

  it("returns to Private another owner's playlist the Member was the only selected User of", async () => {
    const otherId = await createUser(ctx.db);
    const sharedAt = new Date('2026-10-01T00:00:00Z');
    const share = async (name: string, userIds: string[] | null) => {
      const playlist = await createPlaylist(ctx.db, { ownerUserId: adminId, name });
      await setPlaylistShared(ctx.db, {
        ownerUserId: adminId,
        playlistId: playlist.id,
        audience: userIds ? { kind: 'selected', userIds } : { kind: 'everyone' },
        now: sharedAt,
      });
      return playlist.id;
    };
    const onlyMember = await share('Just for you', [memberId]);
    const withOther = await share('For you two', [memberId, otherId]);
    const everyone = await share('For all', null);

    expect((await deleteMember(ctx.db, { userId: memberId })).ok).toBe(true);

    const audience = async (playlistId: string) =>
      (await getPlaylistShare(ctx.db, { ownerUserId: adminId, playlistId }))!.audience;
    expect(await audience(onlyMember)).toBeNull();
    expect(await audience(withOther)).toEqual({ kind: 'selected', userIds: [otherId] });
    expect(await audience(everyone)).toEqual({ kind: 'everyone' });
    const rows = await ctx.pool.query(
      'select id, shared_at, share_audience from playlists where id = any($1) order by name',
      [[onlyMember, withOther]],
    );
    expect(rows.rows).toEqual([
      { id: withOther, shared_at: sharedAt, share_audience: 'selected' },
      { id: onlyMember, shared_at: null, share_audience: 'everyone' },
    ]);
  });

  it('purges the owner’s own Pin of a playlist the delete returns to Private', async () => {
    const playlist = await createPlaylist(ctx.db, { ownerUserId: adminId, name: 'Just for you' });
    await setPlaylistShared(ctx.db, {
      ownerUserId: adminId,
      playlistId: playlist.id,
      audience: { kind: 'selected', userIds: [memberId] },
    });
    await setPlaylistLoungePinned(ctx.db, {
      viewerUserId: adminId,
      playlistId: playlist.id,
      pinned: true,
    });

    expect((await deleteMember(ctx.db, { userId: memberId })).ok).toBe(true);

    await setPlaylistShared(ctx.db, {
      ownerUserId: adminId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });
    expect(
      await isPlaylistLoungePinned(ctx.db, { viewerUserId: adminId, playlistId: playlist.id }),
    ).toBe(false);
  });

  it('queue rows written for the member survive the cascade with a null owner', async () => {
    await seedMemberContent();
    await deleteMember(ctx.db, { userId: memberId });
    const rows = await ctx.db
      .select()
      .from(deletionQueueItems)
      .where(isNull(deletionQueueItems.ownerUserId));
    expect(rows.length).toBeGreaterThan(0);
    // Every queue row lost its owner with the user; none was cascade-deleted.
    expect(await ctx.db.select().from(deletionQueueItems)).toHaveLength(rows.length);
  });
});
