// `download-final-audio`. Pulls a track's final provider
// audio into local storage so the audio route can serve OWN bytes instead of proxying
// the provider stream — the last rung of the cold-start ladder.
//
// The provider final URL is decrypted server-side just before the fetch and never
// leaves this process. The fetch is FREE (no paid call) and uses an INJECTED `fetch`,
// so tests stream fixture bytes with zero network. Bytes are streamed (never buffered
// whole) into storage via the canonical `trackOriginal` key, then recorded as the
// playable `local_original` asset and the track advances to `ready`.
//
// IDEMPOTENT UNDER OVERLAP (Blocking 3): a cheap pre-check skips a track that already
// has a `local_original`; the real work then runs under a per-track TRY advisory lock
// (`withTrackDownloadLock`) so two overlapping jobs never both fetch the provider URL —
// the loser returns `in_progress` immediately. `writeDownloadedTrackAudio`'s atomic
// ready-flip claim is the correctness backstop (only one run lands the asset, flips to
// `ready`, and enqueues analysis; a Dislike committing mid-download makes the claim
// decline). A failed fetch throws so Graphile retries (the lock auto-releases on
// rollback); never resurrects a rejected/deleted track — and when the DB declines a
// write, the just-written object is queued for deletion in the same transaction so it
// can never be orphaned on disk.
//
// The provider fetch runs INSIDE the lock + transaction by design: the under-lock
// status re-check must precede it, and the decline-path orphan deletion must share
// its transaction. It is therefore TIME-BOUNDED (`DEFAULT_DOWNLOAD_TIMEOUT_MS`) so a
// slow-drip response can only pin the pool connection / lock / worker slot briefly,
// and BYTE-BOUNDED (`MAX_TRACK_AUDIO_BYTES`) so a fast one cannot push arbitrary
// volume through the disk reserve inside that window; splitting the fetch out of the
// transaction entirely is a possible follow-up.
//
// KNOWN NARROW WINDOW (deferred): `storage.write` is not transactional with Postgres.
// If the DB transaction fails AFTER the bytes land (before the asset row or the
// orphan deletion item commits), the Graphile retry re-enters and — while the track
// is still downloadable and keeps its title — overwrites the SAME canonical key,
// self-healing. The residual strand needs a DB failure in that window AND, before
// the retry, either the track stopping being downloadable or its title changing
// (the key is built from the current title, so the retry writes a different key);
// accepted. The structural fix, if orphaned bytes ever show up in practice, is a
// staging key promoted to the canonical key only after the DB claim succeeds.

import { Readable } from 'node:stream';
import type { Database } from '@liedmotif/db';
import {
  claimSessionAudioFolder,
  decryptSourceUrl,
  getTrackForDownload,
  getUsageLimits,
  MAX_TRACK_AUDIO_BYTES,
  queueOrphanedDownloadDeletion,
  recordOutputStorageFailure,
  type Transaction,
  withStorageReservation,
  withTrackDownloadLock,
  writeDownloadedTrackAudio,
  writeMeasuredTrackDuration,
} from '@liedmotif/db';
import {
  boundedResponseStream,
  declaredResponseBytes,
  fetchProviderMedia,
  type PinnedFetch,
  type ResolveHostAddresses,
} from '@liedmotif/providers';
import {
  audioContentType,
  extensionForContentType,
  hasStorageHeadroom,
  storageKeys,
  type StorageProvider,
} from '@liedmotif/storage';
import type { Task } from 'graphile-worker';
import { measureStoredAudioDuration } from '../audio/measure-duration';
import { requireEncryptionKey } from './encryption-key';
import { enqueueAnalyzeTrack, enqueueEmbedTrackMetadata } from './enqueue';

export interface DownloadFinalAudioDeps {
  db: Database;
  storage: StorageProvider;
  /**
   * Injected so tests stream fixture bytes — the download never makes a real
   * call. Left unset in production so the egress guard's own IP-pinning
   * transport dials the vetted addresses.
   */
  fetchImpl?: PinnedFetch;
  /** AES-256-GCM key that decrypts the provider final URL server-side. */
  encryptionKey: Buffer;
  /** Enqueue the existing BPM/key analysis once the local audio lands. */
  enqueueAnalyze: (trackId: string) => Promise<void>;
  /** Enqueue the ID3 metadata embed once the local audio lands (MP3s only; the
   *  embed job itself skips other formats). */
  enqueueEmbedMetadata: (trackId: string) => Promise<void>;
  /** Overall bound on the provider fetch + body stream (tests use a tiny value). */
  downloadTimeoutMs?: number;
  /** DNS resolution for the egress guard, injectable so tests never touch DNS. */
  resolveHostAddresses?: ResolveHostAddresses;
}

export interface DownloadFinalAudioPayload {
  trackId: string;
}

export type DownloadOutcome =
  | 'missing'
  | 'already_downloaded'
  | 'not_downloadable'
  | 'no_final'
  // Another job holds the per-track download claim right now — this run did nothing.
  | 'in_progress'
  | 'downloaded'
  // Bytes were fetched and written, but the DB declined the asset (the track
  // stopped being downloadable mid-fetch, or a sibling landed it first); the
  // file was queued as `orphaned_download`. Distinct from `downloaded` so
  // logs/metrics never count a discarded fetch as a landed one.
  | 'discarded';

export interface DownloadFinalAudioResult {
  outcome: DownloadOutcome;
  storageKey?: string;
}

/** Track statuses from which a download may proceed (never resurrect a dead track). */
const DOWNLOADABLE = new Set(['pending', 'streamable']);

/**
 * Overall bound on one provider download (headers AND body). The fetch runs inside
 * the track advisory lock and its DB transaction, so a slow-drip CDN response would
 * otherwise pin a pool connection, the lock, and a worker slot indefinitely while
 * the heartbeat stays green. Generous enough for a multi-MB final on a slow link.
 */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

/** The deferral both volume checks raise: one operator problem, one message. */
const VOLUME_FULL_MESSAGE = 'final-audio download deferred: storage volume is nearly full';

/**
 * Measure a landed final whose provider record carried no usable duration. Runs
 * AFTER the download lock and transaction released: staging plus a full ffmpeg
 * decode can take over a minute, and nothing here needs the claim. A failed
 * measurement never blocks playback — the analysis backfill retries it.
 */
async function measureMissingDuration(
  deps: DownloadFinalAudioDeps,
  trackId: string,
  storageKey: string,
): Promise<void> {
  try {
    const seconds = await measureStoredAudioDuration(deps.storage, storageKey);
    await writeMeasuredTrackDuration(deps.db, trackId, seconds);
  } catch {
    // Unknown duration keeps a limited Session's generation blocked until the sweep repairs it.
  }
}

/** One download attempt under the per-track claim, inside that claim's transaction. */
async function downloadUnderLock(args: {
  deps: DownloadFinalAudioDeps;
  trackId: string;
  /** The session's frozen on-disk folder, claimed by the caller outside the lock. */
  sessionFolder: string | null;
  recordStored: (byteSize: number) => void;
  tx: Transaction;
  claimed: boolean;
}): Promise<DownloadFinalAudioResult> {
  const { deps, trackId, sessionFolder, recordStored, tx, claimed } = args;
  // An overlapping job already owns the claim → bail without fetching.
  if (!claimed) return { outcome: 'in_progress' };

  // Re-read UNDER the lock — a sibling that just committed may have landed the asset.
  const track = await getTrackForDownload(tx, trackId);
  if (!track) return { outcome: 'missing' };
  if (track.hasLocalOriginal) return { outcome: 'already_downloaded' };
  if (!DOWNLOADABLE.has(track.status)) return { outcome: 'not_downloadable' };
  if (!track.finalEncryptedSourceUrl) return { outcome: 'no_final' };

  // A full volume breaks writes app-wide — including Postgres on a one-host
  // deployment — so the last of the disk is not spent on audio. Throwing makes
  // Graphile retry: the provider URL outlives a few backoffs, and the operator
  // freeing space is what resolves it.
  if (!(await hasStorageHeadroom(deps.storage))) throw new Error(VOLUME_FULL_MESSAGE);

  const url = decryptSourceUrl(track.finalEncryptedSourceUrl, deps.encryptionKey);
  // The timeout signal also aborts a mid-stream body, so `storage.write` below
  // rejects rather than draining a trickling response forever.
  const signal = AbortSignal.timeout(deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    // Egress-guarded: http(s) only, no private/metadata hosts
    // (DNS-resolved), every redirect hop re-validated — a malicious provider
    // URL never reaches an internal host from the worker.
    response = await fetchProviderMedia(url, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      signal,
      ...(deps.resolveHostAddresses ? { resolve: deps.resolveHostAddresses } : {}),
    });
  } catch {
    // Sanitized (the decrypted provider URL must never ride an error into logs);
    // throwing makes Graphile retry, and the lock releases on rollback.
    throw new Error('final-audio download failed (blocked, transport error, or timeout)');
  }
  if (!response.ok || !response.body) {
    // Tear down the error body first — a trickling non-OK response must not
    // hold the upstream connection past this throw.
    await response.body?.cancel().catch(() => undefined);
    // A transient/failed fetch → throw so Graphile retries (the lock releases on rollback).
    throw new Error(`final-audio download failed (status ${response.status})`);
  }

  // A declared length is the one thing the volume check can use: the check above
  // could only ask whether the disk was ALREADY too full, since the size arrives
  // with the response headers.
  const declared = declaredResponseBytes(response);
  if (declared !== null && !(await hasStorageHeadroom(deps.storage, declared))) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(VOLUME_FULL_MESSAGE);
  }

  // The provider's declared type is never persisted verbatim: the audio route
  // serves this value back inline, so a hostile or MITM'd `text/html` would
  // become stored XSS in the app origin. Off-allowlist types become mp3 — the
  // same fallback the storage key's extension already takes.
  const contentType = audioContentType(response.headers.get('content-type'));
  const storageKey = storageKeys.trackOriginal(
    track.ownerUserId,
    sessionFolder,
    { id: trackId, title: track.title },
    extensionForContentType(contentType),
  );
  // The body streams under the same ceiling the quota reserved: a timeout bounds
  // how LONG a provider may send, never how much, and the storage adapter
  // removes the partial object when the stream errors.
  const bounded = boundedResponseStream(response, MAX_TRACK_AUDIO_BYTES);
  const stat = await deps.storage.write({
    key: storageKey,
    body: Readable.fromWeb(bounded as Parameters<typeof Readable.fromWeb>[0]),
    mimeType: contentType,
  });
  // A 0-byte local final would outrank the working provider stream and never be
  // re-fetched, so an empty body is a failed attempt: Graphile retries.
  if (stat.byteSize === 0) {
    await deps.storage.delete(storageKey);
    throw new Error('final-audio download failed (empty body)');
  }

  const { written } = await writeDownloadedTrackAudio(tx, {
    trackId,
    storageKey,
    mimeType: contentType,
    byteSize: stat.byteSize,
  });
  if (written) {
    // Only a kept asset occupies the quota; the decline path frees the claim.
    recordStored(stat.byteSize);
  } else {
    // The DB declined the asset: the track stopped being downloadable while the
    // provider bytes streamed (e.g. Disliked mid-fetch — the reject's asset
    // snapshot ran before this file existed), or a lock-less sibling landed the
    // asset first. Either way the object just written has no asset row and no
    // retention path targeting it — queue it for deletion in the SAME
    // transaction as the decline. The deletion consumer's live-key guard keeps
    // the sibling case safe (an asset row referencing this key resolves the
    // item without deleting the file).
    await queueOrphanedDownloadDeletion(tx, {
      ownerUserId: track.ownerUserId,
      trackId,
      storageKey,
    });
  }
  return { outcome: written ? 'downloaded' : 'discarded', storageKey };
}

/**
 * A download that fails on the attempt nobody will retry is given up on. That is
 * a storage failure of a Track the music model did produce, recorded as such so
 * reporting never mistakes it for a failed generation.
 */
export async function runDownloadFinalAudio(
  deps: DownloadFinalAudioDeps,
  payload: DownloadFinalAudioPayload,
  options: { finalAttempt?: boolean } = {},
): Promise<DownloadFinalAudioResult> {
  try {
    return await downloadFinalAudio(deps, payload);
  } catch (error) {
    if (options.finalAttempt) await recordOutputStorageFailure(deps.db, payload.trackId);
    throw error;
  }
}

async function downloadFinalAudio(
  deps: DownloadFinalAudioDeps,
  payload: DownloadFinalAudioPayload,
): Promise<DownloadFinalAudioResult> {
  // Cheap, lock-free pre-check so the common "nothing to do" cases don't take the lock.
  const pre = await getTrackForDownload(deps.db, payload.trackId);
  if (!pre) return { outcome: 'missing' };
  if (pre.hasLocalOriginal) return { outcome: 'already_downloaded' };
  if (!DOWNLOADABLE.has(pre.status)) return { outcome: 'not_downloadable' };
  if (!pre.finalEncryptedSourceUrl) return { outcome: 'no_final' };

  // The session's frozen on-disk folder: reuse the claimed segment, or claim it
  // now from the CURRENT Name (first download names the folder — later renames
  // never split it). On a plain connection, outside the download lock and its
  // transaction: the claim must not serialize sibling downloads behind a slow
  // byte stream, and a claim outliving a failed download is harmless.
  const sessionFolder = pre.session
    ? (pre.session.audioFolderSegment ??
      (await claimSessionAudioFolder(
        deps.db,
        pre.session.id,
        storageKeys.sessionAudioFolder(pre.session),
      )))
    : null;

  // The quota is claimed BEFORE the fetch and settled with what landed: a check
  // taken before an unbounded provider response cannot bound it, and concurrent
  // downloads would otherwise each admit against the same measured total.
  const { storageQuotaBytes } = await getUsageLimits(deps.db);
  const result = await withStorageReservation(
    deps.db,
    { bytes: MAX_TRACK_AUDIO_BYTES, quotaBytes: storageQuotaBytes },
    (recordStored) =>
      withTrackDownloadLock(deps.db, payload.trackId, (tx, claimed) =>
        downloadUnderLock({
          deps,
          trackId: payload.trackId,
          sessionFolder,
          recordStored,
          tx,
          claimed,
        }),
      ),
  );
  // Throwing makes Graphile retry, like the volume check inside.
  if (!result) throw new Error('final-audio download deferred: storage quota is full');

  // Kick off analysis + metadata embedding (and only then) on the run that
  // actually landed the asset.
  if (result.outcome === 'downloaded') {
    if (!(pre.durationSeconds != null && pre.durationSeconds > 0) && result.storageKey) {
      await measureMissingDuration(deps, payload.trackId, result.storageKey);
    }
    await deps.enqueueAnalyze(payload.trackId);
    await deps.enqueueEmbedMetadata(payload.trackId);
  }
  return result;
}

/** Bind to Graphile, serializing per track with `download:<trackId>`. */
export function createDownloadFinalAudioTask(deps: {
  db: Database;
  storage: StorageProvider;
  fetchImpl?: PinnedFetch;
  encryptionKey: Buffer | null;
}): Task {
  return async (payload, helpers) => {
    const encryptionKey = requireEncryptionKey(deps.encryptionKey);
    await runDownloadFinalAudio(
      {
        db: deps.db,
        storage: deps.storage,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        encryptionKey,
        enqueueAnalyze: async (trackId) => {
          const { maxRetriesPerJob } = await getUsageLimits(deps.db);
          await enqueueAnalyzeTrack(helpers.addJob, trackId, maxRetriesPerJob);
        },
        enqueueEmbedMetadata: (trackId) => enqueueEmbedTrackMetadata(helpers.addJob, trackId),
      },
      payload as DownloadFinalAudioPayload,
      { finalAttempt: helpers.job.attempts >= helpers.job.max_attempts },
    );
  };
}
