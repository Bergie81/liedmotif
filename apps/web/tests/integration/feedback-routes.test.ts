import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createQueueItem,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { updateUsageLimits } from '@liedmotif/db';

// Owner-scoped feedback loop routes: save/favorite (library
// retention), dislike (= reroll + reject, no steering, limits respected), and the
// audit-only /api/feedback (Skip). Every route is checked for cross-owner rejection
// (no IDOR) and the dislike reroll is checked never to spend or bypass limits.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers', () => ({
  getMusicProvider: () => ({
    providerKey: 'mock',
    getCapabilities: () => ({ typicalTracksPerRequest: 2 }),
  }),
  getLlmProvider: async () => null,
  getStorageProvider: () => ({ providerKey: 'local-fs' }),
}));

const { POST: savePost } = await import('@/app/api/tracks/save/route');
const { POST: favoritePost } = await import('@/app/api/tracks/favorite/route');
const { POST: dislikePost } = await import('@/app/api/tracks/dislike/route');
const { POST: feedbackPost } = await import('@/app/api/feedback/route');
const { POST: applyMembershipsPost } = await import('@/app/api/playlists/memberships/apply/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postJson(handler: (r: Request) => Promise<Response>, body: unknown) {
  return handler(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function countRows(table: string, where: string, ...params: unknown[]): Promise<number> {
  const r = await testDb.pool.query(
    `select count(*)::int as n from ${table} where ${where}`,
    params,
  );
  return r.rows[0].n as number;
}

/** Seed an owner + active session + one ready track (with audio + a queue slot). */
async function seedTrack(
  ownerUserId: string,
  opts: { providerJobId?: string; providerTrackId?: string } = {},
) {
  const sessionId = await createSession(testDb.db, { ownerUserId });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId =
    opts.providerJobId ?? (await createProviderJob(testDb.db, { generationRequestId: requestId }));
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    providerTrackId: opts.providerTrackId,
    audioStorageKey: `fb/${ownerUserId}/${opts.providerTrackId ?? 'a'}.mp3`,
  });
  const queueItemId = await createQueueItem(testDb.db, {
    activitySessionId: sessionId,
    trackId,
    position: 0,
    state: 'queued',
  });
  return { sessionId, requestId, providerJobId, trackId, queueItemId };
}

/** The other Track of `a`'s ProviderJob, with a slot in `a`'s Session (`queued` unless given). */
async function seedSibling(
  ownerUserId: string,
  a: { sessionId: string; requestId: string; providerJobId: string },
  state: 'queued' | 'skipped' = 'queued',
) {
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: a.requestId,
    providerJobId: a.providerJobId,
    providerTrackId: 'b',
    audioStorageKey: `fb/${ownerUserId}/b.mp3`,
  });
  const queueItemId = await createQueueItem(testDb.db, {
    activitySessionId: a.sessionId,
    trackId,
    position: 1,
    state,
  });
  return { trackId, queueItemId };
}

/** Stop a seeded Session, as the listener's Stop (or the idle sweep) does. */
async function stopSession(sessionId: string): Promise<void> {
  await testDb.pool.query(
    `update activity_sessions set status = 'stopped', end_reason = 'user_stopped', stopped_at = now() where id = $1`,
    [sessionId],
  );
}

/** Switch a seeded Session to "Play existing Tracks" — the mode that buys nothing. */
async function switchToRepeatMode(sessionId: string): Promise<void> {
  await testDb.pool.query(`update activity_sessions set session_mode = 'repeat' where id = $1`, [
    sessionId,
  ]);
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('feedback-routes-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
  holder.ownerUserId = null;
  // Generous default budget unless a test overrides it. The Admin's Track
  // ceiling is opt-in, and settings outlive the truncate, so it is switched on
  // here: with it off the seeded owner (an Admin) has no budget to exhaust.
  await updateUsageLimits(testDb.db, {
    trackCeilingEnabled: true,
    dailyGenerationTasks: 40,
    monthlyGenerationTasks: 400,
    resetTimezone: 'UTC',
  });
});

describe.skipIf(skip)('POST /api/tracks/save (unsave-only — retention is membership)', () => {
  it('rejects saved:true (saving goes through the playlist picker) and unsaves everywhere', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedTrack(owner);

    // The contract pins `saved: false` — saving goes through the picker.
    expect((await postJson(savePost, { trackId, saved: true })).status).toBe(400);

    // Save via the picker commit (Favorites-less: an inline playlist).
    const applied = await (
      await postJson(applyMembershipsPost, {
        trackId,
        playlistIds: [],
        createPlaylistName: 'Picker save',
      })
    ).json();
    expect(applied.ok).toBe(true);
    expect(applied.data.flags.retentionClass).toBe('durable');
    expect(applied.data.createdPlaylistId).not.toBeNull();

    // Unsave removes every membership and returns the track to Ephemeral.
    const unsaved = await (await postJson(savePost, { trackId, saved: false })).json();
    expect(unsaved.data.retentionClass).toBe('ephemeral');
    expect(unsaved.data.savedAt).toBeNull();
    expect(await countRows('playlist_tracks', 'track_id = $1', trackId)).toBe(0);
  });

  it('returns 404 for a cross-owner trackId (no IDOR) and 401 when signed out', async () => {
    const owner = await createUser(testDb.db);
    const { trackId } = await seedTrack(owner);

    const attacker = await createUser(testDb.db);
    holder.ownerUserId = attacker;
    const res = await postJson(savePost, { trackId, saved: false });
    expect(res.status).toBe(404);
    expect(await countRows('feedback_events', 'track_id = $1', trackId)).toBe(0);

    holder.ownerUserId = null;
    expect((await postJson(savePost, { trackId, saved: false })).status).toBe(401);
  });

  it('returns 409 for a rejected track (a Save racing a Dislike cannot pin it)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedTrack(owner);
    await (await postJson(dislikePost, { trackId })).json();

    const res = await postJson(applyMembershipsPost, {
      trackId,
      playlistIds: [],
      createPlaylistName: 'Too late',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('conflict');
    // The refusal wrote nothing: no save flag, no membership, no save audit row.
    expect(await countRows('tracks', 'id = $1 and saved_at is not null', trackId)).toBe(0);
    expect(await countRows('playlist_tracks', 'track_id = $1', trackId)).toBe(0);
    expect(
      await countRows('feedback_events', "track_id = $1 and feedback_type = 'save'", trackId),
    ).toBe(0);
  });
});

describe.skipIf(skip)('POST /api/tracks/favorite', () => {
  it('favorite implies save (Durable); cross-owner is 404', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedTrack(owner);

    const fav = await (await postJson(favoritePost, { trackId, favorited: true })).json();
    expect(fav.data.favoritedAt).not.toBeNull();
    expect(fav.data.savedAt).not.toBeNull(); // implied
    expect(fav.data.retentionClass).toBe('durable');

    const attacker = await createUser(testDb.db);
    holder.ownerUserId = attacker;
    expect((await postJson(favoritePost, { trackId, favorited: true })).status).toBe(404);
  });

  it('returns 409 for a rejected track', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedTrack(owner);
    await (await postJson(dislikePost, { trackId })).json();

    const res = await postJson(favoritePost, { trackId, favorited: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('conflict');
  });
});

describe.skipIf(skip)('POST /api/tracks/dislike (= reroll + reject)', () => {
  it('serves a pre-paid sibling ($0 reroll) and rejects the disliked track', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    // Two tracks from ONE provider job → the unplayed one is the sibling.
    const a = await seedTrack(owner, { providerTrackId: 'a' });
    await seedSibling(owner, a);

    const res = await (await postJson(dislikePost, { trackId: a.trackId })).json();
    expect(res.ok).toBe(true);
    expect(res.data.replacementSource).toBe('sibling');
    expect(res.data.rerollQueued).toBe(true);
    expect(res.data.dislikedAt).not.toBeNull();
    // Audit + reject: a dislike event, the queue slot rejected, the audio dropped.
    expect(
      await countRows('feedback_events', "track_id = $1 and feedback_type = 'dislike'", a.trackId),
    ).toBe(1);
    expect(
      await countRows(
        'activity_session_queue_items',
        "id = $1 and state = 'rejected'",
        a.queueItemId,
      ),
    ).toBe(1);
    expect(await countRows('track_audio_assets', 'track_id = $1', a.trackId)).toBe(0);
  });

  it('spends a fresh call only when no sibling remains and budget allows', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedTrack(owner); // single track in its job → no sibling

    const res = await (await postJson(dislikePost, { trackId })).json();
    expect(res.data.replacementSource).toBe('generation');
    expect(res.data.rerollQueued).toBe(true);
    // The fresh-call reroll intent is persisted on the disliked track, so the
    // worker's next generate copies its request identity (never the live snapshot).
    expect(await countRows('tracks', 'id = $1 and reroll_pending_at is not null', trackId)).toBe(1);
  });

  it('CONCURRENT dislikes of both siblings serialize: one sibling reroll, one fresh-call intent', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const a = await seedTrack(owner, { providerTrackId: 'a' });
    const { trackId: b } = await seedSibling(owner, a);

    // Two tabs dislike the two siblings at the same instant. Without the
    // ProviderJob serialization each would see the OTHER still ready, both
    // would report `sibling`, and NO fresh-call intent would exist — the buffer
    // would then top up from the live snapshot (wrong vibe after Change Vibe).
    const [resA, resB] = await Promise.all([
      postJson(dislikePost, { trackId: a.trackId }).then((r) => r.json()),
      postJson(dislikePost, { trackId: b }).then((r) => r.json()),
    ]);

    const sources = [resA.data.replacementSource, resB.data.replacementSource].sort();
    expect(sources).toEqual(['generation', 'sibling']);
    // Exactly ONE fresh-call intent was recorded (for whichever dislike ran second).
    expect(await countRows('tracks', 'reroll_pending_at is not null')).toBe(1);
  });

  it('a sibling reroll marks NO fresh-call intent (the sibling carries the identity)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const a = await seedTrack(owner, { providerTrackId: 'a' });
    await seedSibling(owner, a);

    const res = await (await postJson(dislikePost, { trackId: a.trackId })).json();
    expect(res.data.replacementSource).toBe('sibling');
    expect(await countRows('tracks', 'id = $1 and reroll_pending_at is not null', a.trackId)).toBe(
      0,
    );
  });

  it('reports none (limit respected) when no sibling AND budget exhausted — and never spends', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId, providerJobId } = await seedTrack(owner); // the seed job = 1 spent task today
    await updateUsageLimits(testDb.db, {
      dailyGenerationTasks: 1, // already spent (the seed job) → over budget
      monthlyGenerationTasks: 400,
      resetTimezone: 'UTC',
    });

    const before = await countRows('provider_jobs', '1 = 1');
    const res = await (await postJson(dislikePost, { trackId })).json();
    expect(res.data.replacementSource).toBe('none');
    expect(res.data.rerollQueued).toBe(false);
    // The route NEVER spends — no new provider job was submitted (no bypass, no double-submit).
    expect(await countRows('provider_jobs', '1 = 1')).toBe(before);
    expect(providerJobId).toBeTruthy();
  });

  it('never queues a fresh call in Repeat mode — the Track goes, nothing is bought', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId, sessionId } = await seedTrack(owner); // single track in its job → no sibling
    await switchToRepeatMode(sessionId);

    const res = await (await postJson(dislikePost, { trackId })).json();
    expect(res.data.replacementSource).toBe('none');
    expect(res.data.rerollQueued).toBe(false);
    // The Track is still rejected — Repeat gates the SPEND, not the removal.
    expect(await countRows('tracks', "id = $1 and status = 'rejected'", trackId)).toBe(1);
    expect(await countRows('tracks', 'reroll_pending_at is not null')).toBe(0);
  });

  it('buys nothing for a Track from a vibe a Change Vibe replaced — the Track still goes', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId, requestId, sessionId } = await seedTrack(owner); // no sibling
    await testDb.pool.query(`update generation_requests set style_revision = 1 where id = $1`, [
      requestId,
    ]);
    await testDb.pool.query(`update activity_sessions set style_revision = 2 where id = $1`, [
      sessionId,
    ]);

    const res = await (await postJson(dislikePost, { trackId })).json();
    expect(res.data.replacementSource).toBe('none');
    expect(res.data.rerollQueued).toBe(false);
    expect(await countRows('tracks', "id = $1 and status = 'rejected'", trackId)).toBe(1);
    expect(await countRows('tracks', 'reroll_pending_at is not null')).toBe(0);
  });

  it('still serves a pre-paid sibling in Repeat mode (an existing Track, $0)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const a = await seedTrack(owner, { providerTrackId: 'a' });
    await seedSibling(owner, a);
    await switchToRepeatMode(a.sessionId);

    const res = await (await postJson(dislikePost, { trackId: a.trackId })).json();
    expect(res.data.replacementSource).toBe('sibling');
    expect(res.data.rerollQueued).toBe(true);
    expect(await countRows('tracks', 'reroll_pending_at is not null')).toBe(0);
  });

  it('a skipped sibling is no replacement: Keep Going records a fresh-call intent', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const a = await seedTrack(owner, { providerTrackId: 'a' });
    await seedSibling(owner, a, 'skipped');

    const res = await (await postJson(dislikePost, { trackId: a.trackId })).json();
    expect(res.data.replacementSource).toBe('generation');
    expect(res.data.rerollQueued).toBe(true);
    expect(await countRows('tracks', 'id = $1 and reroll_pending_at is not null', a.trackId)).toBe(
      1,
    );
  });

  it('a skipped sibling is no replacement: Repeat buys nothing either', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const a = await seedTrack(owner, { providerTrackId: 'a' });
    await seedSibling(owner, a, 'skipped');
    await switchToRepeatMode(a.sessionId);

    const res = await (await postJson(dislikePost, { trackId: a.trackId })).json();
    expect(res.data.replacementSource).toBe('none');
    expect(res.data.rerollQueued).toBe(false);
    expect(await countRows('tracks', 'reroll_pending_at is not null')).toBe(0);
  });

  it('a Dislike in a Stopped Session records no fresh-call intent', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId, sessionId, queueItemId } = await seedTrack(owner); // Keep Going, no sibling
    await stopSession(sessionId);

    const res = await (await postJson(dislikePost, { trackId })).json();
    expect(res.data.replacementSource).toBe('none');
    expect(res.data.rerollQueued).toBe(false);
    expect(await countRows('tracks', 'reroll_pending_at is not null')).toBe(0);
    // The Track is still rejected and audited.
    expect(await countRows('tracks', "id = $1 and status = 'rejected'", trackId)).toBe(1);
    expect(
      await countRows(
        'activity_session_queue_items',
        "id = $1 and state = 'rejected'",
        queueItemId,
      ),
    ).toBe(1);
    expect(
      await countRows('feedback_events', "track_id = $1 and feedback_type = 'dislike'", trackId),
    ).toBe(1);
  });

  it('a Dislike in a Stopped Session still serves a sibling queued in it', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const a = await seedTrack(owner, { providerTrackId: 'a' });
    await seedSibling(owner, a);
    await stopSession(a.sessionId);

    const res = await (await postJson(dislikePost, { trackId: a.trackId })).json();
    expect(res.data.replacementSource).toBe('sibling');
    expect(res.data.rerollQueued).toBe(true);
    expect(await countRows('tracks', 'reroll_pending_at is not null')).toBe(0);
  });

  it('is idempotent: a second dislike is a no-op with no extra reroll/audit', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedTrack(owner);

    await postJson(dislikePost, { trackId });
    const second = await (await postJson(dislikePost, { trackId })).json();
    expect(second.data.rerollQueued).toBe(false);
    expect(second.data.replacementSource).toBe('none');
    expect(
      await countRows('feedback_events', "track_id = $1 and feedback_type = 'dislike'", trackId),
    ).toBe(1);
  });

  // A stale player (second tab or device) can still show a Track the owner
  // deleted; its slot is gone and the buffer already refilled it, so a reroll
  // there would buy a Track nobody lost.
  it('records no reroll for a Track the owner already deleted', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedTrack(owner); // single track in its job → no sibling
    await testDb.pool.query(`update tracks set status = 'deleted' where id = $1`, [trackId]);

    const res = await (await postJson(dislikePost, { trackId })).json();
    expect(res.data.rerollQueued).toBe(false);
    expect(await countRows('tracks', "id = $1 and status = 'deleted'", trackId)).toBe(1);
    expect(await countRows('tracks', 'reroll_pending_at is not null')).toBe(0);
    expect(
      await countRows('feedback_events', "track_id = $1 and feedback_type = 'dislike'", trackId),
    ).toBe(0);
  });

  it('returns 404 for a cross-owner trackId (no IDOR) and leaves it untouched', async () => {
    const owner = await createUser(testDb.db);
    const { trackId } = await seedTrack(owner);
    const attacker = await createUser(testDb.db);
    holder.ownerUserId = attacker;

    expect((await postJson(dislikePost, { trackId })).status).toBe(404);
    expect(await countRows('tracks', "id = $1 and status = 'ready'", trackId)).toBe(1); // unchanged
  });
});

describe.skipIf(skip)('POST /api/feedback (audit-only; Skip soft-negative)', () => {
  it('records a skip audit row without changing any flag', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { sessionId, trackId } = await seedTrack(owner);

    const res = await (
      await postJson(feedbackPost, {
        trackId,
        sessionId,
        type: 'skip',
        value: null,
        freeformText: null,
      })
    ).json();
    expect(res.ok).toBe(true);
    expect(res.data.recorded).toBe(true);
    expect(res.data.feedbackEventId).toBeTruthy();
    expect(
      await countRows('feedback_events', "track_id = $1 and feedback_type = 'skip'", trackId),
    ).toBe(1);
    expect(await countRows('tracks', 'id = $1 and saved_at is null', trackId)).toBe(1); // not retention
  });

  it('rejects a cross-owner trackId (no IDOR) — no audit row', async () => {
    const owner = await createUser(testDb.db);
    const { trackId } = await seedTrack(owner);
    const attacker = await createUser(testDb.db);
    holder.ownerUserId = attacker;

    const res = await postJson(feedbackPost, {
      trackId,
      sessionId: null,
      type: 'skip',
      value: null,
      freeformText: null,
    });
    expect(res.status).toBe(404);
    expect(await countRows('feedback_events', 'track_id = $1', trackId)).toBe(0);
  });

  it('rejects a cross-owner sessionId even with an owned track (no IDOR)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const { trackId } = await seedTrack(owner);
    // A session owned by someone else.
    const other = await createUser(testDb.db);
    const otherSession = await createSession(testDb.db, { ownerUserId: other });

    const res = await postJson(feedbackPost, {
      trackId,
      sessionId: otherSession,
      type: 'skip',
      value: null,
      freeformText: null,
    });
    expect(res.status).toBe(404);
    expect(await countRows('feedback_events', 'track_id = $1', trackId)).toBe(0);
  });
});
