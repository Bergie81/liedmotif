import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../schema';
import { trackAudioAssets, tracks } from '../schema';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import {
  getReadableTrackPlaybackAudio,
  getTrackForDownload,
  writeDownloadedTrackAudio,
} from './tracks-repo';
import {
  upsertProviderTrackWithAssets,
  type ProviderTrackUpsertContext,
} from './provider-results-repo';
import { decryptSourceUrl } from './source-url-crypto';
import { addPlaylistTracks, createPlaylist } from '../playlists/playlists-repo';
import { setPlaylistShared } from '../playlists/playlist-share-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const KEY = randomBytes(32);
const STREAM_URL = 'https://cdn.example/stream/track-A';
const FINAL_URL = 'https://cdn.example/final/track-A.mp3';

describeIfDb('download + stream-source repo', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-download-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  /** Stage a streamable track that already has encrypted provider stream + final assets. */
  async function stagedTrack(
    opts: { withFinal?: boolean } = {},
  ): Promise<{ ctx: ProviderTrackUpsertContext; trackId: string; ownerUserId: string }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const generationRequestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const providerJobId = await createProviderJob(ctx.db, { generationRequestId });
    const upsertCtx: ProviderTrackUpsertContext = {
      ownerUserId,
      generationRequestId,
      providerJobId,
      activitySessionId: sessionId,
      providerKey: 'mock',
      prompt: 'instrumental lofi',
      encryptionKey: KEY,
    };
    const r = await upsertProviderTrackWithAssets(ctx.db, {
      ...upsertCtx,
      track: {
        providerTrackId: 'ptrack-A',
        streamAudioUrl: STREAM_URL,
        durationSeconds: 168,
        ...(opts.withFinal ? { audioUrl: FINAL_URL } : {}),
      },
    });
    return { ctx: upsertCtx, trackId: r.trackId, ownerUserId };
  }

  async function localAssets(trackId: string) {
    return ctx.db
      .select({ storageKey: trackAudioAssets.storageKey, isPlayable: trackAudioAssets.isPlayable })
      .from(trackAudioAssets)
      .where(eq(trackAudioAssets.trackId, trackId))
      .then((rows) => rows);
  }

  it('exposes the decryptable final URL and no local original for a fresh track', async () => {
    const { trackId, ownerUserId } = await stagedTrack({ withFinal: true });
    const dl = await getTrackForDownload(ctx.db, trackId);
    expect(dl).toMatchObject({
      trackId,
      ownerUserId,
      status: 'streamable',
      durationSeconds: 168,
      hasLocalOriginal: false,
    });
    expect(dl!.finalEncryptedSourceUrl).not.toBeNull();
    expect(decryptSourceUrl(dl!.finalEncryptedSourceUrl!, KEY)).toBe(FINAL_URL);
    expect(await getTrackForDownload(ctx.db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('writes the local original, flips status to ready, and is a no-op on a repeat', async () => {
    const { trackId } = await stagedTrack({ withFinal: true });
    const key = `tracks/owner/${trackId}/original.mp3`;

    const first = await writeDownloadedTrackAudio(ctx.db, {
      trackId,
      storageKey: key,
      mimeType: 'audio/mpeg',
      byteSize: 4096,
      durationSeconds: 168,
    });
    expect(first.written).toBe(true);

    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('ready');
    const local = (await getTrackForDownload(ctx.db, trackId))!;
    expect(local.hasLocalOriginal).toBe(true);

    // A repeated download must NOT create a second local asset or re-flip anything.
    const second = await writeDownloadedTrackAudio(ctx.db, {
      trackId,
      storageKey: key,
      mimeType: 'audio/mpeg',
      byteSize: 4096,
    });
    expect(second.written).toBe(false);
    const localOriginalRows = (await localAssets(trackId)).filter((a) => a.storageKey === key);
    expect(localOriginalRows).toHaveLength(1);
  });

  it('never resurrects a rejected track (no local asset, no status change)', async () => {
    const { trackId } = await stagedTrack({ withFinal: true });
    await ctx.db.update(tracks).set({ status: 'rejected' }).where(eq(tracks.id, trackId));

    const r = await writeDownloadedTrackAudio(ctx.db, {
      trackId,
      storageKey: `tracks/owner/${trackId}/original.mp3`,
    });
    expect(r.written).toBe(false);

    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('rejected');
    expect((await getTrackForDownload(ctx.db, trackId))!.hasLocalOriginal).toBe(false);
  });

  it('declines when a Dislike is UNCOMMITTED mid-write: the claim blocks and observes the post-commit status', async () => {
    const { trackId } = await stagedTrack({ withFinal: true });

    // Stage the race: a Dislike transaction has flipped the track to `rejected`
    // but NOT committed when the download's DB write starts. A stale status
    // SELECT would still see `streamable` and land a local asset on a rejected
    // track; the atomic ready-flip claim must instead block on the row lock and
    // re-evaluate against the post-commit row.
    const dislikeTx = await ctx.pool.connect();
    try {
      await dislikeTx.query('begin');
      await dislikeTx.query(
        `update tracks set status = 'rejected', disliked_at = now() where id = $1`,
        [trackId],
      );

      const pendingWrite = writeDownloadedTrackAudio(ctx.db, {
        trackId,
        storageKey: `tracks/owner/${trackId}/original.mp3`,
      });
      // Give the claim time to reach the row lock, then let the Dislike win.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await dislikeTx.query('commit');

      expect((await pendingWrite).written).toBe(false);
    } finally {
      dislikeTx.release();
    }

    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track!.status).toBe('rejected'); // never resurrected
    expect((await getTrackForDownload(ctx.db, trackId))!.hasLocalOriginal).toBe(false); // no orphan row
  });

  it('returns the encrypted provider-stream URL for an owned streamable track (cold-start proxy)', async () => {
    const { trackId, ownerUserId } = await stagedTrack({ withFinal: true });
    const audio = await getReadableTrackPlaybackAudio(ctx.db, {
      viewerUserId: ownerUserId,
      trackId,
    });
    expect(audio).toMatchObject({ finalStorageKey: null, hasProviderStream: true });
    expect(audio!.providerStreamEncryptedUrl).not.toBeNull();
    expect(decryptSourceUrl(audio!.providerStreamEncryptedUrl!, KEY)).toBe(STREAM_URL);

    // Cross-owner stays indistinguishable from missing (the IDOR posture).
    const other = await createUser(ctx.db);
    expect(
      await getReadableTrackPlaybackAudio(ctx.db, { viewerUserId: other, trackId }),
    ).toBeNull();
  });

  it('resolves every asset shape: missing, none, stream-only, final-only, both', async () => {
    const { trackId, ownerUserId } = await stagedTrack({ withFinal: true });

    // Missing id resolves exactly like cross-owner: null.
    expect(
      await getReadableTrackPlaybackAudio(ctx.db, {
        viewerUserId: ownerUserId,
        trackId: '00000000-0000-0000-0000-000000000000',
      }),
    ).toBeNull();

    // Stream-only (fresh streamable track).
    const streamOnly = (await getReadableTrackPlaybackAudio(ctx.db, {
      viewerUserId: ownerUserId,
      trackId,
    }))!;
    expect(streamOnly).toMatchObject({
      finalStorageKey: null,
      finalMimeType: null,
      hasProviderStream: true,
    });

    // Both: land the local final next to the stream asset.
    const key = `tracks/owner/${trackId}/original.mp3`;
    await writeDownloadedTrackAudio(ctx.db, { trackId, storageKey: key, mimeType: 'audio/mpeg' });
    const both = (await getReadableTrackPlaybackAudio(ctx.db, {
      viewerUserId: ownerUserId,
      trackId,
    }))!;
    expect(both).toMatchObject({
      finalStorageKey: key,
      finalMimeType: 'audio/mpeg',
      hasProviderStream: true,
    });

    // Final-only: drop the stream asset.
    await ctx.db
      .delete(trackAudioAssets)
      .where(
        and(
          eq(trackAudioAssets.trackId, trackId),
          eq(trackAudioAssets.assetType, 'provider_stream'),
        ),
      );
    const finalOnly = (await getReadableTrackPlaybackAudio(ctx.db, {
      viewerUserId: ownerUserId,
      trackId,
    }))!;
    expect(finalOnly).toMatchObject({
      finalStorageKey: key,
      hasProviderStream: false,
      providerStreamEncryptedUrl: null,
    });

    // Owned with no assets at all: still owned, so a result — with nothing playable.
    await ctx.db.delete(trackAudioAssets).where(eq(trackAudioAssets.trackId, trackId));
    const none = (await getReadableTrackPlaybackAudio(ctx.db, {
      viewerUserId: ownerUserId,
      trackId,
    }))!;
    expect(none).toEqual({
      finalStorageKey: null,
      finalMimeType: null,
      hasProviderStream: false,
      providerStreamEncryptedUrl: null,
      ownedByViewer: true,
    });
  });

  it('tells the owner from a Visitor of a Lounge-audible track', async () => {
    const { trackId, ownerUserId } = await stagedTrack({ withFinal: true });
    const playlist = await createPlaylist(ctx.db, { ownerUserId, name: 'Shared shelf' });
    await addPlaylistTracks(ctx.db, { ownerUserId, playlistId: playlist.id, trackIds: [trackId] });
    await setPlaylistShared(ctx.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });
    const visitor = await createUser(ctx.db);

    const asOwner = await getReadableTrackPlaybackAudio(ctx.db, {
      viewerUserId: ownerUserId,
      trackId,
    });
    const asVisitor = await getReadableTrackPlaybackAudio(ctx.db, {
      viewerUserId: visitor,
      trackId,
    });
    expect(asOwner!.ownedByViewer).toBe(true);
    expect(asVisitor!.ownedByViewer).toBe(false);
  });

  it('resolves playback audio in ONE database execution (the audio route is the hottest endpoint)', async () => {
    const { trackId, ownerUserId } = await stagedTrack({ withFinal: true });

    let statements = 0;
    const countingDb = drizzle(ctx.pool, {
      schema,
      logger: {
        logQuery: () => {
          statements += 1;
        },
      },
    });

    const audio = await getReadableTrackPlaybackAudio(countingDb, {
      viewerUserId: ownerUserId,
      trackId,
    });
    expect(audio).not.toBeNull();
    expect(statements).toBe(1);
  });
});
