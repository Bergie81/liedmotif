// Idempotent provider-result materialization. When a poll observes a
// provider job's tracks, each normalized track becomes — exactly once, however many
// times the poll repeats — a `tracks` row, its encrypted `track_audio_assets`
// (provider stream/final URLs sealed at rest), and one `activity_session_queue_items`
// slot so the player (`getSessionQueue`) and buffer (`countReadyAheadTracks`) see it.
//
// IDEMPOTENCY is the load-bearing property (the readiness analog of the submit path's
// money safety), and it must hold under OVERLAP, not just re-run: the safety-net cron and a
// self-rescheduling poll can process concurrently. So every write is conflict-guarded
// at the DATABASE level (not check-then-insert, which races) —
//   - the track row by `tracks_provider_key_track_id_unique`,
//   - each audio asset by `track_audio_assets_track_id_asset_type_unique`,
//   - the queue item by `queue_items_session_track_unique`,
// all via `onConflictDoNothing` + `.returning()` so the call learns whether a row was
// ACTUALLY inserted. Two overlapping processors therefore yield exactly one track, one
// queue item, and one asset of each type, and the returned transition flags let the
// caller enqueue downloads / buffer refills only when something really changed.

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { VocalMode } from '@liedmotif/shared';
import type { Database } from '../client';
import { withTransaction } from '../transactions';
import {
  activitySessionQueueItems,
  generationOutputs,
  generationRequests,
  trackAudioAssets,
  tracks,
} from '../schema';
import { nextSessionQueuePosition } from './queue-position';
import { encryptSourceUrl } from './source-url-crypto';

/**
 * Persist the request's early title tease: the
 * first track's display title, recorded when a provider poll first reports
 * per-track data — before any playable audio exists. WRITE-ONCE at the
 * database level (`early_track_title is null` guard), so overlapping polls and
 * later provider renames can never flicker a title the user has been shown.
 */
export async function recordEarlyTrackTitle(
  db: Database,
  args: { generationRequestId: string; title: string },
): Promise<void> {
  await db
    .update(generationRequests)
    .set({ earlyTrackTitle: args.title })
    .where(
      and(
        eq(generationRequests.id, args.generationRequestId),
        isNull(generationRequests.earlyTrackTitle),
      ),
    );
}

/** The provider-job context shared by every track materialized from one poll. */
export interface ProviderTrackUpsertContext {
  ownerUserId: string;
  generationRequestId: string;
  providerJobId: string;
  /** Null when the request outlived its session: no queue item is created then. */
  activitySessionId: string | null;
  providerKey: string;
  prompt: string;
  /** The genre tags of the vibe this track was generated under (the REQUEST's
   * Style Snapshot — after a Change Vibe the session snapshot describes the new
   * vibe while this track still belongs to its own). Stamped on the track row at
   * first materialization; downstream ranking (session summaries, the create
   * screen's personal shortlist) reads `tracks.genreTags`. */
  genreTags?: readonly string[];
  /** The REQUEST's vocal mode (same snapshot rule as `genreTags`). Gates lyric
   * persistence: only vocal tracks ever store lyric text, because an
   * instrumental payload's "lyrics" are provider filler. */
  vocalMode?: VocalMode;
  /** AES-256-GCM key sealing the provider stream/final URLs at rest. */
  encryptionKey: Buffer;
}

/** One normalized track to materialize (URLs are provider-side, encrypted on write). */
export interface ProviderTrackUpsertInput extends ProviderTrackUpsertContext {
  track: {
    providerTrackId: string;
    title?: string;
    streamAudioUrl?: string;
    audioUrl?: string;
    durationSeconds?: number;
    model?: string;
    lyrics?: string;
  };
}

export interface ProviderTrackUpsertResult {
  trackId: string;
  /** True only on the run that first inserted the track row. */
  created: boolean;
  /** True only on the run that actually inserted the `provider_stream` asset. */
  insertedProviderStream: boolean;
  /** True only on the run that actually inserted the `provider_final` asset. */
  insertedProviderFinal: boolean;
  /** True only on the run that actually inserted the session queue item. */
  insertedQueueItem: boolean;
  /**
   * DURABLE download need, derived from the track's CURRENT asset state (a
   * `provider_final` exists but no `local_original` yet) — NOT from whether THIS call
   * inserted the final asset. The caller enqueues `download-final-audio` (stable
   * `jobKey`) whenever this is true, so a download lost between the asset commit and
   * its enqueue is recovered by ANY later reprocess (crash/retry safety) while the
   * jobKey collapses repeats to at most one pending download per track.
   */
  needsDownload: boolean;
}

export async function upsertProviderTrackWithAssets(
  db: Database,
  input: ProviderTrackUpsertInput,
): Promise<ProviderTrackUpsertResult> {
  const { track } = input;
  // Provider durations are fractional seconds (e.g. 168.08); the column is an integer.
  const durationSeconds =
    typeof track.durationSeconds === 'number' ? Math.round(track.durationSeconds) : undefined;
  // Re-guard like every optional field: snapshot tags come from jsonb, so drop
  // non-strings/blanks and dedupe after the same normalize the readers apply.
  const genreTags = [
    ...new Set(
      (input.genreTags ?? [])
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  // Lyric text may only land on VOCAL tracks (see the context field contract).
  const lyrics = input.vocalMode === 'vocal' ? track.lyrics : undefined;
  return withTransaction(db, async (tx) => {
    // 1) Track row — idempotent on (providerKey, providerTrackId). A repeat conflicts
    //    and we re-select the existing id; the existing row's status is never touched
    //    (so a downloaded `ready` track never regresses to `streamable`).
    const inserted = await tx
      .insert(tracks)
      .values({
        ownerUserId: input.ownerUserId,
        generationRequestId: input.generationRequestId,
        providerJobId: input.providerJobId,
        providerKey: input.providerKey,
        providerTrackId: track.providerTrackId,
        prompt: input.prompt,
        status: 'streamable',
        ...(track.title !== undefined ? { title: track.title } : {}),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(track.model !== undefined ? { providerModel: track.model } : {}),
        ...(genreTags.length > 0 ? { genreTags } : {}),
        ...(input.vocalMode !== undefined ? { vocalMode: input.vocalMode } : {}),
        ...(lyrics !== undefined ? { lyrics } : {}),
      })
      .onConflictDoNothing({
        target: [tracks.providerKey, tracks.providerTrackId],
        // The arbiter-index predicate must match the PARTIAL unique index. For
        // `onConflictDoNothing` drizzle renders `config.where` (not `targetWhere`)
        // immediately after the target columns — exactly where PG infers the index.
        where: sql`${tracks.providerTrackId} is not null`,
      })
      .returning({ id: tracks.id, analyticsId: tracks.analyticsId });

    let trackId: string;
    let created: boolean;
    if (inserted[0]) {
      trackId = inserted[0].id;
      created = true;
      // A Track row is only ever inserted carrying a playable URL, so this is
      // first playability — and sharing the insert's transaction and its
      // conflict arbiter makes the ledger exactly-once per distinct output.
      await tx.insert(generationOutputs).values({
        ownerUserId: input.ownerUserId,
        analyticsTrackId: inserted[0].analyticsId,
        trackId,
      });
    } else {
      const [existing] = await tx
        .select({ id: tracks.id, status: tracks.status })
        .from(tracks)
        .where(
          and(
            eq(tracks.providerKey, input.providerKey),
            eq(tracks.providerTrackId, track.providerTrackId),
          ),
        )
        .limit(1);
      trackId = existing!.id;
      created = false;

      // A Track the owner disliked or deleted mid-flight already had its assets
      // removed; re-attaching provider URLs would revive downloads, refills and
      // cutovers for it and leave sealed URLs on the tombstone.
      if (existing!.status === 'rejected' || existing!.status === 'deleted') {
        return {
          trackId,
          created,
          insertedProviderStream: false,
          insertedProviderFinal: false,
          insertedQueueItem: false,
          needsDownload: false,
        };
      }

      // A stream-first poll creates the Track before the provider knows its
      // duration. Enrich that SAME row when the later final result supplies
      // the value; otherwise the Queue keeps exposing `null`, leaving the
      // player's total length unknown and seeking disabled. Never overwrite
      // an established duration on an idempotent reprocess.
      if (durationSeconds !== undefined) {
        await tx
          .update(tracks)
          .set({ durationSeconds })
          .where(and(eq(tracks.id, trackId), isNull(tracks.durationSeconds)));
      }

      // Lyrics follow the duration rule: a stream-first poll can create the
      // Track before the provider has written the words (they land at
      // TEXT_SUCCESS). Enrich write-once; never rewrite captured lyrics.
      if (lyrics !== undefined) {
        await tx
          .update(tracks)
          .set({ lyrics })
          .where(and(eq(tracks.id, trackId), isNull(tracks.lyrics)));
      }
    }

    // 2) Audio assets — conflict-safe on `(track_id, asset_type)`, so overlapping
    //    processors never double-insert and a later poll only ADDS the now-available
    //    `provider_final`. `.returning()` tells us if THIS run inserted the row.
    let insertedProviderStream = false;
    if (track.streamAudioUrl) {
      const r = await tx
        .insert(trackAudioAssets)
        .values({
          trackId,
          assetType: 'provider_stream',
          storageProvider: input.providerKey,
          encryptedSourceUrl: encryptSourceUrl(track.streamAudioUrl, input.encryptionKey),
          // Playable so the cold-start proxy can serve the stream before the download.
          isPlayable: true,
        })
        .onConflictDoNothing({ target: [trackAudioAssets.trackId, trackAudioAssets.assetType] })
        .returning({ id: trackAudioAssets.id });
      insertedProviderStream = r.length > 0;
    }
    let insertedProviderFinal = false;
    if (track.audioUrl) {
      const r = await tx
        .insert(trackAudioAssets)
        .values({
          trackId,
          assetType: 'provider_final',
          storageProvider: input.providerKey,
          encryptedSourceUrl: encryptSourceUrl(track.audioUrl, input.encryptionKey),
          // Not playable until downloaded to `local_original` (the route serves bytes).
          isPlayable: false,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        })
        .onConflictDoNothing({ target: [trackAudioAssets.trackId, trackAudioAssets.assetType] })
        .returning({ id: trackAudioAssets.id });
      insertedProviderFinal = r.length > 0;
    }

    // 3) Queue item — conflict-safe on `(session, track)` (partial: track not null), so
    //    a track is queued at most once per session even under overlap. The position is
    //    computed in-transaction; a conflict simply discards it (no row, no gap).
    let insertedQueueItem = false;
    if (input.activitySessionId) {
      const next = await nextSessionQueuePosition(tx, input.activitySessionId);
      const r = await tx
        .insert(activitySessionQueueItems)
        .values({
          activitySessionId: input.activitySessionId,
          trackId,
          generationRequestId: input.generationRequestId,
          position: next,
          state: 'queued',
        })
        .onConflictDoNothing({
          target: [activitySessionQueueItems.activitySessionId, activitySessionQueueItems.trackId],
          // Matches the PARTIAL unique index predicate (see the drizzle `where` gotcha).
          where: sql`${activitySessionQueueItems.trackId} is not null`,
        })
        .returning({ id: activitySessionQueueItems.id });
      insertedQueueItem = r.length > 0;
    }

    // DURABLE download need from the CURRENT asset state (re-read inside the same tx),
    // not the inserted-this-call flag: a final asset present with no local original yet
    // means a download is still owed — so a reprocess after a lost enqueue recovers it.
    const presentTypes = new Set(
      (
        await tx
          .select({ assetType: trackAudioAssets.assetType })
          .from(trackAudioAssets)
          .where(eq(trackAudioAssets.trackId, trackId))
      ).map((a) => a.assetType),
    );
    const needsDownload = presentTypes.has('provider_final') && !presentTypes.has('local_original');

    return {
      trackId,
      created,
      insertedProviderStream,
      insertedProviderFinal,
      insertedQueueItem,
      needsDownload,
    };
  });
}
