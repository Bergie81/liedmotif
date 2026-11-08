// Track writes/reads for the generation controller.
//
// `insertGeneratedTrack` is the ONE place a provider-produced track row is born,
// so it encodes the "new tracks land Ephemeral" rule structurally: it sets none
// of the retention flags (`savedAt`/`favoritedAt`/`dislikedAt`) — Ephemeral is
// the derived retention class at insert, NOT an age timer (deleting the session
// is what later reclaims the audio).

import { and, asc, count, eq, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import {
  ANALYSIS_STATUSES,
  validateTrackAnalysis,
  type AnalysisStatus,
  type BpmSource,
  type TrackAnalysisMeasurements,
} from '@liedmotif/shared';
import type { Database } from '../client';
import { withTransaction, type DbOrTx, type Transaction } from '../transactions';
import { viewerCanReadTrack } from '../playlists/lounge-audible';
import { DOWNLOAD_ADVISORY_LOCK_CLASS } from '../advisory-locks';
import { clearOutputStorageFailure } from '../analytics/generation-repo';
import { trackStatus as trackStatusEnum } from '../schema/enums';
import { activitySessions, generationRequests, tracks, trackAudioAssets } from '../schema';

type TrackStatus = (typeof trackStatusEnum.enumValues)[number];

/**
 * A reference to a track's stored audio. Structurally compatible with the
 * providers' `TrackBpmKeyAnalyzer` input (the worker passes this straight in) but
 * declared here so `@liedmotif/db` stays free of a dependency on `@liedmotif/providers`.
 */
export interface AnalysisAudioRef {
  storageKey?: string;
  checksum?: string;
  byteSize?: number;
  durationSeconds?: number;
}

/** Audio captured for a freshly downloaded track (stored AS-IS — no transcode). */
export interface GeneratedTrackAudio {
  storageKey: string;
  assetType?: 'provider_stream' | 'provider_final' | 'local_original';
  storageProvider?: string;
  mimeType?: string;
  byteSize?: number;
  durationSeconds?: number;
  checksum?: string;
}

export interface InsertGeneratedTrackInput {
  ownerUserId: string;
  generationRequestId: string;
  providerJobId: string;
  providerKey: string;
  providerTrackId: string;
  prompt: string;
  title?: string;
  durationSeconds?: number;
  providerModel?: string;
  vocalMode?: 'instrumental' | 'vocal';
  /** Readiness at insert; a downloaded track is `ready` (the default). */
  status?: TrackStatus;
  audio?: GeneratedTrackAudio;
}

/**
 * Insert a provider-produced track. Ephemeral-on-insert by construction: no
 * retention flag is set. Stores the provider audio AS-IS as a `local_original`
 * asset when supplied (no re-encode).
 */
export async function insertGeneratedTrack(
  db: Database,
  input: InsertGeneratedTrackInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(tracks)
    .values({
      ownerUserId: input.ownerUserId,
      generationRequestId: input.generationRequestId,
      providerJobId: input.providerJobId,
      providerKey: input.providerKey,
      providerTrackId: input.providerTrackId,
      prompt: input.prompt,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.providerModel !== undefined ? { providerModel: input.providerModel } : {}),
      ...(input.vocalMode !== undefined ? { vocalMode: input.vocalMode } : {}),
      status: input.status ?? 'ready',
      // Retention flags are intentionally left unset → Ephemeral.
    })
    .returning({ id: tracks.id });
  const id = row!.id;

  if (input.audio) {
    await db.insert(trackAudioAssets).values({
      trackId: id,
      assetType: input.audio.assetType ?? 'local_original',
      storageProvider: input.audio.storageProvider ?? 'local-fs',
      storageKey: input.audio.storageKey,
      ...(input.audio.mimeType !== undefined ? { mimeType: input.audio.mimeType } : {}),
      ...(input.audio.byteSize !== undefined ? { byteSize: input.audio.byteSize } : {}),
      ...(input.audio.durationSeconds !== undefined
        ? { durationSeconds: input.audio.durationSeconds }
        : {}),
      ...(input.audio.checksum !== undefined ? { checksum: input.audio.checksum } : {}),
      isPlayable: true,
    });
  }
  return { id };
}

/** A readable track's audio, resolved for the `/api/audio/<trackId>` byte route. */
export interface ReadableTrackPlaybackAudio {
  /** Storage key of the DOWNLOADED local-final asset, or null until it is downloaded. */
  finalStorageKey: string | null;
  /** Recorded MIME type of the local-final asset (the route can fall back to the key). */
  finalMimeType: string | null;
  /** Whether a cold-start provider-stream asset exists (the stream-proxy case). */
  hasProviderStream: boolean;
  /**
   * The ENCRYPTED provider stream URL of the cold-start `provider_stream` asset, or
   * null when none exists. SERVER-SIDE ONLY: the route decrypts and proxies it — it
   * never reaches the client. Present whenever `hasProviderStream` is true.
   */
  providerStreamEncryptedUrl: string | null;
}

/**
 * Resolve a track's playable audio for the authorized audio route, scoped to
 * owner-or-Lounge-audible (the one read widening; `viewerCanReadTrack`
 * is the single predicate): returns null when the track does not exist OR the
 * viewer may not read it, so a cross-owner-private or revoked id is
 * indistinguishable from a missing one (the caller returns 404 — the IDOR
 * posture). When the track IS readable, returns its
 * downloaded local-final asset's storage key (null until the download lands) and
 * whether a provider-stream asset exists. The storage key never leaves the
 * server — the route streams bytes, not paths.
 */
export async function getReadableTrackPlaybackAudio(
  db: Database,
  params: { viewerUserId: string; trackId: string },
): Promise<ReadableTrackPlaybackAudio | null> {
  // One execution for authorization + assets: this backs every audio byte-range
  // request, so the round-trip count is load-bearing. The left join keeps a
  // readable track with no assets distinguishable (one all-null row) from a
  // missing/unreadable track (no rows), preserving the uniform-404 posture.
  const rows = await db
    .select({
      assetType: trackAudioAssets.assetType,
      storageKey: trackAudioAssets.storageKey,
      mimeType: trackAudioAssets.mimeType,
      encryptedSourceUrl: trackAudioAssets.encryptedSourceUrl,
      isPlayable: trackAudioAssets.isPlayable,
    })
    .from(tracks)
    .leftJoin(trackAudioAssets, eq(trackAudioAssets.trackId, tracks.id))
    .where(and(eq(tracks.id, params.trackId), viewerCanReadTrack(params.viewerUserId)));
  if (rows.length === 0) return null;

  // The asset-type match rules out the all-null row of an asset-less track.
  const final = rows.find(
    (asset) =>
      asset.assetType === 'local_original' &&
      asset.isPlayable &&
      asset.storageKey != null &&
      asset.storageKey !== '',
  );
  const providerStream = rows.find(
    (asset) =>
      asset.assetType === 'provider_stream' &&
      asset.isPlayable &&
      asset.encryptedSourceUrl != null &&
      asset.encryptedSourceUrl !== '',
  );

  return {
    finalStorageKey: final?.storageKey ?? null,
    finalMimeType: final?.mimeType ?? null,
    hasProviderStream: providerStream !== undefined,
    providerStreamEncryptedUrl: providerStream?.encryptedSourceUrl ?? null,
  };
}

/** The inputs the `download-final-audio` job needs to fetch + store a track's final. */
export interface TrackForDownload {
  trackId: string;
  ownerUserId: string;
  status: TrackStatus;
  /** Cosmetic track title (nullable); names the stored file for browsability. */
  title: string | null;
  durationSeconds: number | null;
  /** The originating session (names the storage folder); null when the request
   *  outlived its session row (`activitySessionId` is set-null on delete).
   *  `audioFolderSegment` is the frozen on-disk folder — null until the
   *  session's first download claims it. */
  session: { id: string; title: string | null; audioFolderSegment: string | null } | null;
  /** Encrypted provider final URL, or null when there is no `provider_final` asset. */
  finalEncryptedSourceUrl: string | null;
  /** True once the `local_original` is stored — the download is then a no-op. */
  hasLocalOriginal: boolean;
}

/**
 * Load a track's download context: its owner + originating session and titles (for
 * the storage key), the encrypted provider-final URL to fetch, and whether the local
 * original already exists. The encrypted URL never leaves the server; the worker
 * decrypts it just before the fetch.
 */
export async function getTrackForDownload(
  executor: DbOrTx,
  trackId: string,
): Promise<TrackForDownload | null> {
  const [track] = await executor
    .select({
      trackId: tracks.id,
      ownerUserId: tracks.ownerUserId,
      status: tracks.status,
      title: tracks.title,
      durationSeconds: tracks.durationSeconds,
      sessionId: activitySessions.id,
      sessionTitle: activitySessions.title,
      sessionAudioFolderSegment: activitySessions.audioFolderSegment,
    })
    .from(tracks)
    .leftJoin(generationRequests, eq(tracks.generationRequestId, generationRequests.id))
    .leftJoin(activitySessions, eq(generationRequests.activitySessionId, activitySessions.id))
    .where(eq(tracks.id, trackId))
    .limit(1);
  if (!track) return null;

  const assets = await executor
    .select({
      assetType: trackAudioAssets.assetType,
      encryptedSourceUrl: trackAudioAssets.encryptedSourceUrl,
    })
    .from(trackAudioAssets)
    .where(eq(trackAudioAssets.trackId, trackId));
  const final = assets.find((a) => a.assetType === 'provider_final');
  const hasLocalOriginal = assets.some((a) => a.assetType === 'local_original');
  const { sessionId, sessionTitle, sessionAudioFolderSegment, ...trackFields } = track;
  return {
    ...trackFields,
    session: sessionId
      ? { id: sessionId, title: sessionTitle, audioFolderSegment: sessionAudioFolderSegment }
      : null,
    finalEncryptedSourceUrl: final?.encryptedSourceUrl ?? null,
    hasLocalOriginal,
  };
}

/**
 * Claim the session's frozen on-disk audio folder segment; the first writer
 * wins. The conditional UPDATE sets it only while null, and the re-read
 * returns whatever actually stuck — a concurrent claimer blocks on the row
 * lock, then reads the winner's committed value — so every download of a
 * session agrees on ONE folder, and a later Rename or Change Vibe
 * can never split it. Run on a plain connection (not the download transaction):
 * the row lock must last one statement, and a claim surviving a failed
 * download is harmless — the folder name is only cosmetic browsability.
 */
export async function claimSessionAudioFolder(
  db: Database,
  sessionId: string,
  proposedSegment: string,
): Promise<string> {
  await db
    .update(activitySessions)
    .set({ audioFolderSegment: proposedSegment })
    .where(and(eq(activitySessions.id, sessionId), isNull(activitySessions.audioFolderSegment)));
  const [row] = await db
    .select({ segment: activitySessions.audioFolderSegment })
    .from(activitySessions)
    .where(eq(activitySessions.id, sessionId))
    .limit(1);
  // A vanished session (deleted mid-claim) keeps the proposed segment: the key
  // stays deterministic and the track is about to land in `unsorted/` anyway.
  return row?.segment ?? proposedSegment;
}

/**
 * Run `fn` inside a transaction holding a TRY (non-blocking) per-track advisory lock, so
 * only ONE download job actually fetches the provider bytes for a track at a time
 * (Blocking 3): the winner gets `claimed: true` and does the fetch/persist under the
 * lock; an overlapping loser gets `claimed: false` IMMEDIATELY and returns without
 * fetching. The lock is transaction-scoped — it auto-releases on commit/rollback, so a
 * failed fetch frees it for the Graphile retry. `writeDownloadedTrackAudio`'s atomic
 * ready-flip claim remains the correctness backstop; this lock is the efficiency guard
 * against a double FETCH.
 */
export async function withTrackDownloadLock<T>(
  db: Database,
  trackId: string,
  fn: (tx: Transaction, claimed: boolean) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (tx) => {
    const res = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${DOWNLOAD_ADVISORY_LOCK_CLASS}, hashtext(${trackId})) as locked`,
    );
    const locked = (res as unknown as { rows: { locked: boolean }[] }).rows[0]?.locked === true;
    return fn(tx, locked);
  });
}

/** Track statuses from which a finished download may advance a track to `ready`. */
const DOWNLOADABLE_TRACK_STATUSES = ['pending', 'streamable'] as const;

export interface WriteDownloadedTrackAudioInput {
  trackId: string;
  storageKey: string;
  storageProvider?: string;
  mimeType?: string;
  byteSize?: number;
  durationSeconds?: number;
  checksum?: string;
}

/**
 * Persist a downloaded final as the playable `local_original` asset and advance the
 * track to `ready` (so `getReadableTrackPlaybackAudio` serves local bytes). The guarded
 * ready-flip UPDATE runs FIRST and is the single atomic accept/decline claim: it
 * blocks behind a concurrent writer's row lock (e.g. a Dislike flipping the track to
 * `rejected` mid-download) and re-evaluates against the POST-commit row, so the
 * decision can never rest on a stale status read — a plain SELECT here would see the
 * pre-Dislike snapshot and commit a local asset on a rejected track. The asset row is
 * inserted only after the claim succeeds, in the same transaction; on ANY decline the
 * caller queues the just-written file as `orphaned_download`, so declined bytes are
 * never stranded. The insert keeps `onConflictDoNothing` on
 * `track_audio_assets_track_id_asset_type_unique` as a lock-less-misuse backstop —
 * only the run that actually lands the asset reports `written: true` and owns the
 * analyze enqueue. Runs on the caller's executor (the download job holds a
 * transaction + advisory lock around this).
 */
export async function writeDownloadedTrackAudio(
  executor: DbOrTx,
  input: WriteDownloadedTrackAudioInput,
): Promise<{ written: boolean }> {
  const claimed = await executor
    .update(tracks)
    .set({ status: 'ready' })
    .where(
      and(eq(tracks.id, input.trackId), inArray(tracks.status, [...DOWNLOADABLE_TRACK_STATUSES])),
    )
    .returning({ id: tracks.id });
  // Missing, already ready (sibling landed it), or no longer downloadable
  // (rejected/deleted/failed — never resurrected).
  if (claimed.length === 0) return { written: false };

  const inserted = await executor
    .insert(trackAudioAssets)
    .values({
      trackId: input.trackId,
      assetType: 'local_original',
      storageProvider: input.storageProvider ?? 'local-fs',
      storageKey: input.storageKey,
      isPlayable: true,
      ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
      ...(input.byteSize !== undefined ? { byteSize: input.byteSize } : {}),
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.checksum !== undefined ? { checksum: input.checksum } : {}),
    })
    .onConflictDoNothing({ target: [trackAudioAssets.trackId, trackAudioAssets.assetType] })
    .returning({ id: trackAudioAssets.id });
  if (inserted.length > 0) await clearOutputStorageFailure(executor, input.trackId);
  return { written: inserted.length > 0 };
}

/** One analysis job's persisted outcome. */
export interface WriteTrackAnalysisInput extends TrackAnalysisMeasurements {
  trackId: string;
  analysisStatus: Exclude<AnalysisStatus, 'pending'>;
  analysisVersion: number;
  analysisAttemptedAt: Date;
  bpmSource?: BpmSource | null;
  /** The request's persisted generation-time target, for the ±10% period check. */
  targetBpm?: number | null;
}

/**
 * Persist one analysis outcome: measurements + provenance in a single UPDATE.
 * Every numeric field is validated against physical-plausibility
 * bounds BEFORE the write (BPM 40–220, LUFS −70–0, TP −20–+3 dBTP, anchors ≥ 0,
 * periods within ±10% of the target beat period, confidence 0–1) — downstream
 * edge policy trusts these numbers, so an implausible value must never land.
 * The analyzer deliberately does NOT write `musicalKey`: that column is
 * documented as a MEASURED value and measured key is deferred (left for a real
 * key analyzer rather than overloading it with the target key).
 *
 * COMPARE-AND-SET: the UPDATE only applies while the stored
 * `analysis_version` is NULL (never analyzed, or reset by the boot-probe
 * reanalysis path) or BELOW the writing job's version — a stale in-flight job
 * can never overwrite newer results, and a duplicate re-run at the same
 * version is a no-op. Returns whether the write landed.
 */
export async function writeTrackAnalysis(
  db: Database,
  input: WriteTrackAnalysisInput,
): Promise<{ written: boolean }> {
  const problems = validateTrackAnalysis(input, { targetBpm: input.targetBpm ?? null });
  if (problems.length > 0) {
    throw new Error(`refusing analysis write for track ${input.trackId}: ${problems.join('; ')}`);
  }
  const updated = await db
    .update(tracks)
    .set({
      bpmEstimate: input.bpmEstimate ?? null,
      bpmSource: input.bpmSource ?? null,
      bpmConfidence: input.bpmConfidence ?? null,
      lufsIntegrated: input.integratedLufs ?? null,
      truePeakDb: input.truePeakDb ?? null,
      headBeatAnchorSeconds: input.headBeatAnchorSeconds ?? null,
      headBeatPeriodSeconds: input.headBeatPeriodSeconds ?? null,
      tailBeatAnchorSeconds: input.tailBeatAnchorSeconds ?? null,
      tailBeatPeriodSeconds: input.tailBeatPeriodSeconds ?? null,
      analysisStatus: input.analysisStatus,
      analysisVersion: input.analysisVersion,
      analysisAttemptedAt: input.analysisAttemptedAt,
    })
    .where(
      and(
        eq(tracks.id, input.trackId),
        or(isNull(tracks.analysisVersion), lt(tracks.analysisVersion, input.analysisVersion)),
      ),
    )
    .returning({ id: tracks.id });
  return { written: updated.length > 0 };
}

/**
 * The boot-probe reanalysis path: a host that couldn't measure
 * (no ffmpeg, or a resource shortage) wrote `unavailable` provenance; once
 * the worker boot probe finds ffmpeg, those rows return to `pending` with a
 * NULL version so the CAS write above accepts the re-analysis and the
 * backfill sweep re-selects them. Rows stamped by a NEWER analyzer version
 * are left alone — an older worker booting during a rolling deployment must
 * not clear the version and re-open a row its own (older) analyzer would
 * then win back past the CAS. Returns the affected track ids (the caller
 * logs the count; the sweep does the enqueueing).
 */
export async function resetUnavailableTrackAnalyses(
  db: Database,
  opts: { currentVersion: number },
): Promise<string[]> {
  const rows = await db
    .update(tracks)
    .set({ analysisStatus: 'pending', analysisVersion: null })
    .where(
      and(
        eq(tracks.analysisStatus, 'unavailable'),
        or(isNull(tracks.analysisVersion), lte(tracks.analysisVersion, opts.currentVersion)),
      ),
    )
    .returning({ id: tracks.id });
  return rows.map((row) => row.id);
}

/**
 * Backfill selection: ready tracks whose downloaded final has no
 * CURRENT analysis — never analyzed (`pending`, NULL version) or analyzed by
 * an older analyzer version. Rows already stamped at `currentVersion` are
 * excluded by construction, which is exactly the "`unavailable` hosts are not
 * re-selected" rule: an ffmpeg-less run stamps `unavailable` at the current
 * version once, and only the boot-probe reset (above) makes it selectable
 * again. Oldest tracks first; `limit` is the sweep's per-tick rate limit.
 */
export async function listTracksNeedingAnalysis(
  db: Database,
  opts: { currentVersion: number; limit: number },
): Promise<string[]> {
  const rows = await db
    .select({ id: tracks.id })
    .from(tracks)
    .innerJoin(
      trackAudioAssets,
      and(
        eq(trackAudioAssets.trackId, tracks.id),
        eq(trackAudioAssets.assetType, 'local_original'),
      ),
    )
    .where(
      and(
        eq(tracks.status, 'ready'),
        or(isNull(tracks.analysisVersion), lt(tracks.analysisVersion, opts.currentVersion)),
      ),
    )
    .orderBy(asc(tracks.createdAt))
    .limit(opts.limit);
  return rows.map((row) => row.id);
}

/**
 * Analysis-status counts over non-deleted tracks, zero-filled so every status
 * is present for observability. Deleted rows
 * linger until retention cleanup and would misreport as `pending`.
 */
export async function countTracksByAnalysisStatus(
  db: Database,
): Promise<Record<AnalysisStatus, number>> {
  const rows = await db
    .select({ status: tracks.analysisStatus, total: count() })
    .from(tracks)
    .where(ne(tracks.status, 'deleted'))
    .groupBy(tracks.analysisStatus);
  const counts = Object.fromEntries(ANALYSIS_STATUSES.map((status) => [status, 0])) as Record<
    AnalysisStatus,
    number
  >;
  for (const row of rows) counts[row.status] = row.total;
  return counts;
}

/** A track joined to its audio ref and its REQUEST's generation-time target BPM. */
export interface TrackForAnalysis {
  trackId: string;
  ownerUserId: string;
  status: TrackStatus;
  audio: AnalysisAudioRef;
  /**
   * The persisted `generation_requests.target_bpm` this track was generated
   * against — the analyzer's anchor. NEVER the live snapshot: after a Change Vibe
   * the snapshot describes the NEW vibe while this track still carries its own
   * target (null on legacy requests → the estimator runs unanchored).
   */
  targetBpm: number | null;
}

/**
 * Load the inputs the `analyze-track-bpm-key` job needs: the track's downloaded
 * audio ref (the `local_original` asset) and its own request's generation-time
 * target BPM (the analysis anchor — see `TrackForAnalysis.targetBpm`).
 */
export async function getTrackForAnalysis(
  db: Database,
  trackId: string,
): Promise<TrackForAnalysis | null> {
  const [row] = await db
    .select({
      trackId: tracks.id,
      durationSeconds: tracks.durationSeconds,
      ownerUserId: tracks.ownerUserId,
      status: tracks.status,
      targetBpm: generationRequests.targetBpm,
    })
    .from(tracks)
    .leftJoin(generationRequests, eq(tracks.generationRequestId, generationRequests.id))
    .where(eq(tracks.id, trackId))
    .limit(1);
  if (!row) return null;

  const [asset] = await db
    .select({
      storageKey: trackAudioAssets.storageKey,
      byteSize: trackAudioAssets.byteSize,
      durationSeconds: trackAudioAssets.durationSeconds,
      checksum: trackAudioAssets.checksum,
    })
    .from(trackAudioAssets)
    .where(
      and(eq(trackAudioAssets.trackId, trackId), eq(trackAudioAssets.assetType, 'local_original')),
    )
    .limit(1);

  const durationSeconds = row.durationSeconds ?? asset?.durationSeconds;
  const audio: AnalysisAudioRef = {
    ...(asset?.storageKey != null ? { storageKey: asset.storageKey } : {}),
    ...(asset?.checksum != null ? { checksum: asset.checksum } : {}),
    ...(asset?.byteSize != null ? { byteSize: asset.byteSize } : {}),
    ...(durationSeconds != null ? { durationSeconds } : {}),
  };
  return {
    trackId: row.trackId,
    ownerUserId: row.ownerUserId,
    status: row.status,
    audio,
    targetBpm: row.targetBpm,
  };
}

/**
 * Replace one Track's title with the owner's own text (one-way and
 * cosmetic — no feedback meaning, no retention change, siblings untouched).
 * Validation (non-blank, bounded) lives at the API edge; this is the plain
 * owner-scoped write. Null when the track is absent/not owned.
 */
export async function renameTrack(
  db: Database,
  args: { ownerUserId: string; trackId: string; title: string },
): Promise<{ trackId: string; title: string } | null> {
  const [row] = await db
    .update(tracks)
    .set({ title: args.title })
    .where(and(eq(tracks.id, args.trackId), eq(tracks.ownerUserId, args.ownerUserId)))
    .returning({ trackId: tracks.id });
  return row ? { trackId: row.trackId, title: args.title } : null;
}
