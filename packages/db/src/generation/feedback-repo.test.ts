import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveTrackRetentionClass } from '@liedmotif/shared';
import {
  connectTestDb,
  createCoverImage,
  createGenerationRequest,
  createProviderJob,
  createQueueItem,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  markTrackPlayed,
  rawTrackRow,
  seedReadyTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import {
  getLibraryTracks,
  getOwnedTrackSummary,
  recordFeedbackEvent,
  rejectDislikedTrack,
  REJECT_PURGE_REASON,
} from './feedback-repo';
import { applyTrackMemberships, setTrackFavorited, unsaveTrackEverywhere } from '../playlists';

// Owner-scoped feedback + library writes/reads against the live test DB.
// Retention writes are membership-backed; the playlists repo suite owns their
// full semantics, and here they exercise the removed-track guards.
// `feedback_events` is the audit trail; the Dislike path reuses the eviction
// mechanism (Reject class + queued purge). Every read/write is checked for
// cross-owner isolation (no IDOR).

const skip = !TEST_DATABASE_URL;
const NOW = new Date('2026-06-20T12:00:00Z');

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('feedback-repo-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
});

async function countRows(table: string, where: string, ...params: unknown[]): Promise<number> {
  const result = await testDb.pool.query(
    `select count(*)::int as n from ${table} where ${where}`,
    params,
  );
  return result.rows[0].n as number;
}

describe.skipIf(skip)('flag writes on removed (rejected/deleted) tracks', () => {
  /** A track that already left the library (Dislike or purge set its status). */
  async function seedRemovedTrack(status: 'rejected' | 'deleted') {
    const owner = await createUser(testDb.db);
    const requestId = await createGenerationRequest(testDb.db, { ownerUserId: owner });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const trackId = await createTrack(testDb.db, {
      ownerUserId: owner,
      generationRequestId: requestId,
      providerJobId: jobId,
      status,
    });
    return { owner, trackId };
  }

  it('refuses a Save (membership apply) on a rejected track: no flag change, no audit row', async () => {
    const { owner, trackId } = await seedRemovedTrack('rejected');

    const result = await applyTrackMemberships(testDb.db, {
      ownerUserId: owner,
      trackId,
      playlistIds: [],
      createPlaylistName: 'Should not exist',
      now: NOW,
    });
    expect(result).toBe('removed');

    const row = await rawTrackRow(testDb.db, trackId);
    expect(row?.saved_at).toBeNull();
    expect(await countRows('feedback_events', 'track_id = $1', trackId)).toBe(0);
    expect(await countRows('playlists', 'name = $1', 'Should not exist')).toBe(0);
  });

  it('refuses Favorite on a deleted track', async () => {
    const { owner, trackId } = await seedRemovedTrack('deleted');

    const result = await setTrackFavorited(testDb.db, {
      ownerUserId: owner,
      trackId,
      favorited: true,
      now: NOW,
    });
    expect(result).toBe('removed');

    const row = await rawTrackRow(testDb.db, trackId);
    expect(row?.favorited_at).toBeNull();
    expect(row?.saved_at).toBeNull();
  });

  it('refuses Unsave too (the track is no longer flaggable at all)', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: true, now: NOW });
    await rejectDislikedTrack(testDb.db, { ownerUserId, trackId, now: NOW });

    const result = await unsaveTrackEverywhere(testDb.db, { ownerUserId, trackId });
    expect(result).toBe('removed');
  });

  it('serializes with a concurrent Dislike: a Save entering mid-reject is refused, not lost', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);

    // Simulate rejectDislikedTrack's first statement: an uncommitted transaction
    // holding the track's row lock with the reject already applied.
    const dislikeTx = await testDb.pool.connect();
    try {
      await dislikeTx.query('begin');
      await dislikeTx.query(
        `update tracks set disliked_at = now(), status = 'rejected' where id = $1`,
        [trackId],
      );

      // The Save arrives while the reject is in flight. Its locked read must WAIT
      // for the dislike to commit (not read the stale pre-reject snapshot) and
      // then refuse the write.
      const savePromise = setTrackFavorited(testDb.db, {
        ownerUserId,
        trackId,
        favorited: true,
        now: NOW,
      });
      await new Promise((resolve) => setTimeout(resolve, 50)); // let it reach the row lock
      await dislikeTx.query('commit');

      expect(await savePromise).toBe('removed');
      const row = await rawTrackRow(testDb.db, trackId);
      expect(row?.saved_at).toBeNull();
      expect(await countRows('feedback_events', 'track_id = $1', trackId)).toBe(0);
    } finally {
      dislikeTx.release();
    }
  });
});

describe.skipIf(skip)('rejectDislikedTrack', () => {
  async function seedTrackWithQueue(
    ownerUserId?: string,
    queueItemState: 'queued' | 'played' = 'queued',
  ) {
    const owner = ownerUserId ?? (await createUser(testDb.db));
    const sessionId = await createSession(testDb.db, { ownerUserId: owner });
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId: owner,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const trackId = await createTrack(testDb.db, {
      ownerUserId: owner,
      generationRequestId: requestId,
      providerJobId: jobId,
      audioStorageKey: `reject/${owner}/track.mp3`,
    });
    const queueItemId = await createQueueItem(testDb.db, {
      activitySessionId: sessionId,
      trackId,
      position: 0,
      state: queueItemState,
    });
    return { owner, sessionId, trackId, queueItemId };
  }

  it('rejects the track, hides its audio, queues the ~24h purge, and audits the dislike', async () => {
    const { owner, sessionId, trackId, queueItemId } = await seedTrackWithQueue();

    const result = await rejectDislikedTrack(testDb.db, {
      ownerUserId: owner,
      trackId,
      activitySessionId: sessionId,
      now: NOW,
    });
    expect(result).toEqual({ alreadyDisliked: false, dislikedAt: NOW });

    const row = await rawTrackRow(testDb.db, trackId);
    expect(row?.status).toBe('rejected');
    expect(row?.disliked_at).not.toBeNull();
    // Reject retention class (fast-delete), regardless of any other flag.
    expect(
      deriveTrackRetentionClass({
        savedAt: row?.saved_at as Date | null,
        favoritedAt: row?.favorited_at as Date | null,
        dislikedAt: row?.disliked_at as Date | null,
      }),
    ).toBe('reject');

    // Audit row.
    expect(
      await countRows('feedback_events', "track_id = $1 and feedback_type = 'dislike'", trackId),
    ).toBe(1);
    // Removed from the queue (so the buffer controller tops up = the reroll).
    expect(
      await countRows(
        'activity_session_queue_items',
        "id = $1 and state = 'rejected'",
        queueItemId,
      ),
    ).toBe(1);
    // Audio hidden immediately (assets dropped) + file purge queued for +24h.
    expect(await countRows('track_audio_assets', 'track_id = $1', trackId)).toBe(0);
    expect(
      await countRows(
        'deletion_queue_items',
        'track_id = $1 and reason = $2 and delete_after = $3',
        trackId,
        REJECT_PURGE_REASON,
        new Date(NOW.getTime() + 24 * 3600_000).toISOString(),
      ),
    ).toBe(1);
  });

  it('is idempotent: a second Dislike changes nothing and writes no new rows', async () => {
    const { owner, trackId } = await seedTrackWithQueue();
    await rejectDislikedTrack(testDb.db, { ownerUserId: owner, trackId, now: NOW });

    const second = await rejectDislikedTrack(testDb.db, {
      ownerUserId: owner,
      trackId,
      now: new Date('2026-06-21T00:00:00Z'),
    });
    expect(second?.alreadyDisliked).toBe(true);
    expect(
      await countRows('feedback_events', "track_id = $1 and feedback_type = 'dislike'", trackId),
    ).toBe(1);
    expect(await countRows('deletion_queue_items', 'track_id = $1', trackId)).toBe(1);
  });

  it('leaves a terminal queue item untouched when a played track is disliked from history', async () => {
    const { owner, sessionId, trackId, queueItemId } = await seedTrackWithQueue(
      undefined,
      'played',
    );

    const result = await rejectDislikedTrack(testDb.db, {
      ownerUserId: owner,
      trackId,
      activitySessionId: sessionId,
      now: NOW,
    });
    expect(result).toEqual({ alreadyDisliked: false, dislikedAt: NOW });

    // The track is rejected as usual, but the terminal slot keeps its history —
    // only LIVE queue items move to `rejected` (per `QUEUE_ITEM_TRANSITIONS`).
    const row = await rawTrackRow(testDb.db, trackId);
    expect(row?.status).toBe('rejected');
    expect(
      await countRows('activity_session_queue_items', "id = $1 and state = 'played'", queueItemId),
    ).toBe(1);
  });

  it('rejects a cross-owner track (null) and leaves it untouched (no IDOR)', async () => {
    const { trackId } = await seedTrackWithQueue();
    const attacker = await createUser(testDb.db);

    const result = await rejectDislikedTrack(testDb.db, {
      ownerUserId: attacker,
      trackId,
      now: NOW,
    });
    expect(result).toBeNull();
    const row = await rawTrackRow(testDb.db, trackId);
    expect(row?.status).toBe('ready'); // unchanged
    expect(row?.disliked_at).toBeNull();
    expect(await countRows('feedback_events', 'track_id = $1', trackId)).toBe(0);
  });
});

describe.skipIf(skip)('recordFeedbackEvent (audit-only, e.g. Skip)', () => {
  it('appends a skip audit row without touching flags', async () => {
    const { ownerUserId, sessionId, trackId } = await seedReadyTrack(testDb.db);
    const { id } = await recordFeedbackEvent(testDb.db, {
      userId: ownerUserId,
      trackId,
      activitySessionId: sessionId,
      feedbackType: 'skip',
    });
    expect(id).toBeTruthy();
    expect(
      await countRows('feedback_events', "track_id = $1 and feedback_type = 'skip'", trackId),
    ).toBe(1);
    const row = await rawTrackRow(testDb.db, trackId);
    expect(row?.saved_at).toBeNull(); // skip is not retention
  });
});

describe.skipIf(skip)('getLibraryTracks / getOwnedTrackSummary', () => {
  /** A ready track with a display title and (optionally) genre tags. */
  async function seedTitledTrack(
    owner: string,
    sessionId: string,
    title: string,
    genreTags: string[] = [],
  ): Promise<string> {
    const { trackId } = await seedReadyTrack(testDb.db, { ownerUserId: owner, sessionId });
    await testDb.pool.query('update tracks set title = $1, genre_tags = $2::jsonb where id = $3', [
      title,
      JSON.stringify(genreTags),
      trackId,
    ]);
    return trackId;
  }

  /** The owner's History-view track ids for one search term, id-sorted. */
  async function searchHistory(owner: string, term: string): Promise<string[]> {
    const result = await getLibraryTracks(testDb.db, {
      ownerUserId: owner,
      view: 'history',
      limit: 50,
      search: term,
    });
    return result.items.map((t) => t.id).sort();
  }

  it('search matches track title, origin session title, and genre tags (case-insensitive)', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, {
      ownerUserId: owner,
      title: 'Deep Focus Beats',
    });
    const piano = await seedTitledTrack(owner, sessionId, 'Rainy Piano');
    const synth = await seedTitledTrack(owner, sessionId, 'Thunder Run', ['synthwave']);

    expect(await searchHistory(owner, 'rainy')).toEqual([piano]);
    expect(await searchHistory(owner, 'SYNTHWAVE')).toEqual([synth]);
    expect(await searchHistory(owner, 'deep focus')).toEqual([piano, synth].sort());
    expect(await searchHistory(owner, 'xylophone')).toEqual([]);
  });

  it('search finds a genre tag typed as the card shows it, and none from under two letters', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner, title: 'Neutral' });
    const dnb = await seedTitledTrack(owner, sessionId, 'Carrier', ['drum-and-bass']);
    const moody = await seedTitledTrack(owner, sessionId, 'Mood Carrier');
    await testDb.pool.query('update tracks set mood = $1 where id = $2', ['deep-house', moody]);

    expect(await searchHistory(owner, 'drum & bass')).toEqual([dnb]);
    expect(await searchHistory(owner, 'deep house')).toEqual([]);
    expect(await searchHistory(owner, '--')).toEqual([]);
    expect(await searchHistory(owner, 'd#')).toEqual([]);
  });

  it('search matches the widened shared surface: prompt, mood, and activity', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner, title: 'Neutral' });
    const byMood = await seedTitledTrack(owner, sessionId, 'Mood Carrier');
    await testDb.pool.query('update tracks set mood = $1 where id = $2', ['rainy', byMood]);
    const byActivity = await seedTitledTrack(owner, sessionId, 'Activity Carrier');
    await testDb.pool.query('update tracks set activity = $1 where id = $2', [
      'rain running',
      byActivity,
    ]);
    const byPrompt = await seedTitledTrack(owner, sessionId, 'Prompt Carrier');
    await testDb.pool.query('update tracks set prompt = $1 where id = $2', [
      'lofi for rainy nights',
      byPrompt,
    ]);
    await seedTitledTrack(owner, sessionId, 'Bystander');

    expect(await searchHistory(owner, 'rainy')).toEqual([byMood, byPrompt].sort());
    expect(await searchHistory(owner, 'rain')).toEqual([byMood, byActivity, byPrompt].sort());
  });

  it('search treats LIKE metacharacters as literal text', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner });
    const percent = await seedTitledTrack(owner, sessionId, '100% Focus');
    await seedTitledTrack(owner, sessionId, 'Purely Different');

    expect(await searchHistory(owner, '%')).toEqual([percent]);
  });

  it('search composes with cursor paging', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner });
    const matching: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      matching.push(await seedTitledTrack(owner, sessionId, `Match ${i}`));
    }
    await seedTitledTrack(owner, sessionId, 'Other');

    const page1 = await getLibraryTracks(testDb.db, {
      ownerUserId: owner,
      view: 'history',
      limit: 2,
      search: 'match',
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await getLibraryTracks(testDb.db, {
      ownerUserId: owner,
      view: 'history',
      limit: 2,
      search: 'match',
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const seen = [...page1.items, ...page2.items].map((t) => t.id).sort();
    expect(seen).toEqual([...matching].sort());
  });

  it('pages History without dropping tracks created within the same millisecond', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner });
    const ids: string[] = [];
    for (const createdAt of [
      '2026-01-01T00:00:00.100000Z',
      '2026-01-01T00:00:00.123456Z',
      '2026-01-01T00:00:00.123789Z',
    ]) {
      const id = await seedTitledTrack(owner, sessionId, createdAt);
      await testDb.pool.query('update tracks set created_at = $1 where id = $2', [createdAt, id]);
      ids.push(id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await getLibraryTracks(testDb.db, {
        ownerUserId: owner,
        view: 'history',
        limit: 1,
        cursor,
      });
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it('lists ONLY the owner’s saved tracks (no cross-owner leakage)', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    // One active session per owner (the partial unique index forbids two), many tracks.
    const ownerSession = await createSession(testDb.db, {
      ownerUserId: owner,
      title: 'Morning Focus',
    });
    const otherSession = await createSession(testDb.db, { ownerUserId: other });
    const mine = await seedReadyTrack(testDb.db, { ownerUserId: owner, sessionId: ownerSession });
    const theirs = await seedReadyTrack(testDb.db, { ownerUserId: other, sessionId: otherSession });
    const unsaved = await seedReadyTrack(testDb.db, {
      ownerUserId: owner,
      sessionId: ownerSession,
    });

    await testDb.pool.query('update tracks set saved_at = $1 where id = $2', [NOW, mine.trackId]);
    await markTrackPlayed(testDb.db, {
      ownerUserId: owner,
      activitySessionId: ownerSession,
      trackId: mine.trackId,
    });
    await testDb.pool.query('update tracks set saved_at = $1 where id = $2', [NOW, theirs.trackId]);

    const lib = await getLibraryTracks(testDb.db, { ownerUserId: owner, view: 'saved', limit: 50 });
    const ids = lib.items.map((t) => t.id);
    expect(ids).toContain(mine.trackId);
    expect(ids).not.toContain(theirs.trackId); // owner isolation
    expect(ids).not.toContain(unsaved.trackId); // not saved
    expect(lib.items.find((t) => t.id === mine.trackId)?.hasPlayableAudio).toBe(true);
    expect(lib.items.find((t) => t.id === mine.trackId)?.hasPlayed).toBe(true);
    expect(lib.items.find((t) => t.id === mine.trackId)?.originSessionTitle).toBe('Morning Focus');
  });

  it('favorites view returns only favorited tracks; history excludes rejected', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner });
    const a = await seedReadyTrack(testDb.db, { ownerUserId: owner, sessionId });
    const b = await seedReadyTrack(testDb.db, { ownerUserId: owner, sessionId });
    await setTrackFavorited(testDb.db, {
      ownerUserId: owner,
      trackId: a.trackId,
      favorited: true,
      now: NOW,
    });
    await rejectDislikedTrack(testDb.db, { ownerUserId: owner, trackId: b.trackId, now: NOW });

    const favs = await getLibraryTracks(testDb.db, {
      ownerUserId: owner,
      view: 'favorites',
      limit: 50,
    });
    expect(favs.items.map((t) => t.id)).toEqual([a.trackId]);

    const history = await getLibraryTracks(testDb.db, {
      ownerUserId: owner,
      view: 'history',
      limit: 50,
    });
    expect(history.items.map((t) => t.id)).toContain(a.trackId);
    expect(history.items.map((t) => t.id)).not.toContain(b.trackId); // rejected leaves the library
  });

  it('Saved and Favorites exclude tracks that were flagged BEFORE being rejected/deleted', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner });
    const kept = await seedReadyTrack(testDb.db, { ownerUserId: owner, sessionId });
    const disliked = await seedReadyTrack(testDb.db, { ownerUserId: owner, sessionId });
    const purged = await seedReadyTrack(testDb.db, { ownerUserId: owner, sessionId });
    for (const t of [kept, disliked, purged]) {
      await setTrackFavorited(testDb.db, {
        ownerUserId: owner,
        trackId: t.trackId,
        favorited: true,
        now: NOW,
      });
    }
    // Flags predate the removal: dislike one, hard-mark the other as purged.
    await rejectDislikedTrack(testDb.db, { ownerUserId: owner, trackId: disliked.trackId });
    await testDb.pool.query(`update tracks set status = 'deleted' where id = $1`, [purged.trackId]);

    for (const view of ['saved', 'favorites'] as const) {
      const list = await getLibraryTracks(testDb.db, { ownerUserId: owner, view, limit: 50 });
      expect(list.items.map((t) => t.id)).toEqual([kept.trackId]);
    }
  });

  it('uses the origin Session cover for every Track from that Session', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner });
    const sessionCover = await createCoverImage(testDb.db);
    const ownCover = await createCoverImage(testDb.db);
    await testDb.pool.query('update activity_sessions set cover_image_id = $1 where id = $2', [
      sessionCover,
      sessionId,
    ]);
    const inherits = await seedReadyTrack(testDb.db, { ownerUserId: owner, sessionId });
    const hasOwn = await seedReadyTrack(testDb.db, { ownerUserId: owner, sessionId });
    await testDb.pool.query('update tracks set cover_image_id = $1 where id = $2', [
      ownCover,
      hasOwn.trackId,
    ]);

    const history = await getLibraryTracks(testDb.db, {
      ownerUserId: owner,
      view: 'history',
      limit: 50,
    });
    expect(history.items.find((t) => t.id === inherits.trackId)?.coverImageId).toBe(sessionCover);
    expect(history.items.find((t) => t.id === hasOwn.trackId)?.coverImageId).toBe(sessionCover);
  });

  it('pages with a cursor (limit honored, nextCursor walks the rest)', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t = await seedReadyTrack(testDb.db, { ownerUserId: owner, sessionId });
      await testDb.pool.query('update tracks set saved_at = $1 where id = $2', [
        new Date(NOW.getTime() + i * 1000),
        t.trackId,
      ]);
      ids.push(t.trackId);
    }

    const page1 = await getLibraryTracks(testDb.db, {
      ownerUserId: owner,
      view: 'saved',
      limit: 2,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await getLibraryTracks(testDb.db, {
      ownerUserId: owner,
      view: 'saved',
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    const seen = [...page1.items, ...page2.items].map((t) => t.id).sort();
    expect(seen).toEqual([...ids].sort());
  });

  it('getOwnedTrackSummary is owner-scoped (null for a cross-owner id)', async () => {
    const owner = await createUser(testDb.db);
    const { trackId } = await seedReadyTrack(testDb.db, { ownerUserId: owner });
    const attacker = await createUser(testDb.db);

    expect((await getOwnedTrackSummary(testDb.db, { ownerUserId: owner, trackId }))?.id).toBe(
      trackId,
    );
    expect(await getOwnedTrackSummary(testDb.db, { ownerUserId: attacker, trackId })).toBeNull();
  });
});
