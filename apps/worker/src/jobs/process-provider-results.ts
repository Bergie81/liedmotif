// `process-provider-results`. Materializes a provider job's polled tracks
// into the durable model: one `tracks` row + encrypted `track_audio_assets` + one
// `activity_session_queue_items` slot per track, all IDEMPOTENTLY (see
// `upsertProviderTrackWithAssets`). The poll job calls the CORE inline with the
// status result it already fetched — provider URLs therefore never travel through a
// Graphile job payload (which would persist them). The standalone task is the
// RECOVERY path: the poll enqueues it (keyed `process:<jobId>`) when it finds a job
// already CAS'd `ready` — i.e. a previous attempt crashed between the terminal write
// and materialization — and it re-derives the result server-side from
// `{ providerJobId }` so it carries no URL either.
//
// After materializing it enqueues a `download-final-audio` for every track whose final
// URL is ready, then one `ensure-session-buffer` so the controller re-evaluates the
// buffer now that fresh tracks exist.

import type { Database } from '@liedmotif/db';
import {
  getProviderJobForPoll,
  markSessionDurationBatchMaterialized,
  performVibeSwitchCutover,
  recordEarlyTrackTitle,
  upsertProviderTrackWithAssets,
  type ProviderJobForPoll,
  type StyleSnapshot,
} from '@liedmotif/db';
import {
  deriveSiblingTrackTitles,
  sessionStyleSnapshotSchema,
  type MusicProvider,
  type NormalizedTrack,
} from '@liedmotif/providers';
import { narrowTo, VOCAL_MODES } from '@liedmotif/shared';
import type { Task } from 'graphile-worker';
import { requireEncryptionKey } from './encryption-key';
import { enqueueBufferRefill, enqueueDownloadFinalAudio } from './enqueue';

export interface ProcessProviderResultsDeps {
  db: Database;
  /** AES-256-GCM key sealing provider stream/final URLs at rest. */
  encryptionKey: Buffer;
  /** Enqueue the final-audio download for a track whose final URL is ready. */
  enqueueDownload: (trackId: string) => Promise<void>;
  /** Re-evaluate the session buffer after fresh tracks land. */
  enqueueBuffer: (sessionId: string) => Promise<void>;
}

export interface ProcessProviderResultsInput {
  job: ProviderJobForPoll;
  tracks: NormalizedTrack[];
  /** The provider's final response: settles the batch for the Session duration target. */
  complete?: boolean;
}

export interface ProcessProviderResultsResult {
  processedTrackIds: string[];
  downloadsEnqueued: string[];
}

/** A track is worth materializing once it carries at least one server-side URL. */
function hasPlayableUrl(track: NormalizedTrack): boolean {
  return Boolean(track.streamAudioUrl) || Boolean(track.audioUrl);
}

/**
 * DISTINCT display titles for one call's sibling tracks. A provider call yields
 * several tracks (Suno: 2) but takes ONE submitted title, so in custom mode every
 * sibling echoes the same name — derive our own per-track titles instead, from the
 * request's recorded index (`titleSeed`) and its frozen vibe (the Session's
 * creative LLM pool when present, the numbered deterministic scheme otherwise).
 * The ordinal multiplier is `requestedTrackCount` — a per-request CONSTANT — never the count
 * of tracks visible this poll: a partial poll (Suno `FIRST_SUCCESS` delivers one
 * track before `SUCCESS` delivers both) must mint the same ordinals as the full
 * one, since `onConflictDoNothing` freezes each title at first materialization.
 * Returns null (keep provider titles as-is) when the seed or a parseable vibe
 * is missing — requests predating the seed, or a session row already deleted.
 */
function deriveDisplayTitles(job: ProviderJobForPoll, vibe: StyleSnapshot | null): string[] | null {
  if (job.titleSeed == null) return null;
  const parsed = sessionStyleSnapshotSchema.safeParse(vibe ?? undefined);
  if (!parsed.success) return null;
  // The creative pool is Session-wide and append-only: a refill grows the live
  // pool after this request froze its copy, so the longer pool names the same
  // title at every ordinal the shorter one has, plus the ones it was refilled for.
  const live = sessionStyleSnapshotSchema.safeParse(job.sessionSnapshot ?? undefined);
  const livePool = live.data?.trackTitles ?? [];
  const named =
    livePool.length > parsed.data.trackTitles.length
      ? { ...parsed.data, trackTitles: livePool }
      : parsed.data;
  return deriveSiblingTrackTitles(named, job.titleSeed, job.requestedTrackCount);
}

/** Core: idempotently materialize the tracks and enqueue downloads + a buffer refill. */
export async function runProcessProviderResults(
  deps: ProcessProviderResultsDeps,
  input: ProcessProviderResultsInput,
): Promise<ProcessProviderResultsResult> {
  const { job } = input;
  const processedTrackIds: string[] = [];
  const downloadsEnqueued: string[] = [];
  let newWork = false;

  // A deleted owner leaves the request behind as spend ledger (null owner);
  // there is nobody to materialize for, and a track insert would violate the
  // owner FK. The poll loop already no-ops earlier — this is the backstop.
  if (job.ownerUserId === null) return { processedTrackIds, downloadsEnqueued };
  const ownerUserId = job.ownerUserId;

  // The one vibe every derived facet of these tracks comes from, titles
  // included: the request's OWN snapshot. The session snapshot is only the
  // legacy fallback — a Change Vibe rewrites it, and these tracks belong to the
  // vibe they were generated under.
  const requestVibe = job.requestSnapshot ?? job.sessionSnapshot;
  const displayTitles = deriveDisplayTitles(job, requestVibe);
  const genreTags = requestVibe?.genreTags;
  // Snapshots are permissive jsonb — only the two known modes pass through.
  const vocalMode = narrowTo(VOCAL_MODES, requestVibe?.vocalMode);

  // Early title tease: the moment the provider
  // reports ANY per-track data — typically the text stage, before playable
  // audio exists — persist the FIRST track's display title so the queue
  // endpoint can narrate "Composing '<title>'…". The derived sibling title
  // (what materialization will name the track) wins; the provider's own title
  // is only the legacy fallback. The write is once-only in the repo, so a
  // shown title never flickers. Absent titles (instrumental text stages,
  // blank provider fields) simply persist nothing.
  if (input.tracks.length > 0) {
    const tease = displayTitles?.[0] ?? input.tracks[0]?.title?.trim();
    if (tease) {
      await recordEarlyTrackTitle(deps.db, {
        generationRequestId: job.generationRequestId,
        title: tease,
      });
    }
  }

  // `k` is the track's position in the provider's FULL list (not the playable
  // subset), so a sibling keeps the same ordinal on every poll regardless of which
  // siblings are playable yet. A track beyond `requestedTrackCount` (provider
  // over-delivery) keeps its provider title rather than colliding with the next
  // request's ordinals.
  for (const [k, track] of input.tracks.entries()) {
    // Tracks are keyed by (provider, provider track id) across every owner, so
    // an id-less track would merge into one row shared by all id-less tracks.
    if (!hasPlayableUrl(track) || !track.providerTrackId) continue;
    const displayTitle = displayTitles?.[k];
    // The upsert's `track` input is structurally the `NormalizedTrack`, and the repo
    // re-guards each optional field before writing, so pass it through directly —
    // with the display title swapped in so this call's siblings never share a name.
    const result = await upsertProviderTrackWithAssets(deps.db, {
      ownerUserId,
      generationRequestId: job.generationRequestId,
      providerJobId: job.jobId,
      activitySessionId: job.activitySessionId,
      providerKey: job.providerKey,
      prompt: job.prompt,
      ...(genreTags ? { genreTags } : {}),
      ...(vocalMode ? { vocalMode } : {}),
      encryptionKey: deps.encryptionKey,
      track: displayTitle ? { ...track, title: displayTitle } : track,
    });
    processedTrackIds.push(result.trackId);
    newWork ||= result.created || result.needsDownload;
    // Enqueue the download from DURABLE need (a final asset exists with no local original
    // yet), NOT the inserted-this-call flag — so a download lost between the asset commit
    // and its enqueue is recovered by any later reprocess. The stable `download:<trackId>`
    // jobKey (default `replace`) collapses repeats to at most one pending per track.
    if (result.needsDownload) {
      await deps.enqueueDownload(result.trackId);
      downloadsEnqueued.push(result.trackId);
    }
  }

  if (input.complete) await markSessionDurationBatchMaterialized(deps.db, job.generationRequestId);

  // Refill the buffer only when this run advanced something durable: a track
  // materialized for the first time, or a download still owed (both re-derive on
  // a reprocess, so a lost refill recovers; the stable `buffer:<sessionId>`
  // jobKey dedupes repeats). A pure no-op reprocess — everything already
  // materialized and downloaded — enqueues nothing.
  // (The paid-submit path this can reach stays exactly-once-safe.)
  if (newWork && job.activitySessionId) {
    // Materialization is the moment a track becomes playable, so an armed
    // switch-now Change Vibe is evaluated here: if one of this run's tracks is
    // the first playable new-vibe track, older queued items are set aside and
    // the switch clears (a no-op otherwise — see `performVibeSwitchCutover`).
    await performVibeSwitchCutover(deps.db, job.activitySessionId);
    await deps.enqueueBuffer(job.activitySessionId);
  }

  return { processedTrackIds, downloadsEnqueued };
}

export interface ProcessProviderResultsPayload {
  providerJobId: string;
}

/**
 * Bind to Graphile. The standalone task re-derives the tracks server-side (a free
 * `getGenerationStatus` poll) so no provider URL is ever serialized into the job
 * payload; `download-final-audio` and `ensure-session-buffer` are enqueued via the
 * Graphile helpers, keyed so retries/overlaps coalesce.
 *
 * RECOVERY CONTRACT (enforced, not just documented): it materializes only for a job
 * the poll already drove `ready` — never for an in-flight or failed job an errant
 * enqueue points it at. And a `ready` job whose fresh provider read is NOT complete
 * (transient inconsistency, expired retention) throws instead of silently no-opping,
 * so Graphile retries the recovery on a bounded backoff.
 */
export function createProcessProviderResultsTask(deps: {
  db: Database;
  getMusic: () => Promise<MusicProvider>;
  encryptionKey: Buffer | null;
}): Task {
  return async (payload, helpers) => {
    const encryptionKey = requireEncryptionKey(deps.encryptionKey);
    const { providerJobId } = payload as ProcessProviderResultsPayload;
    const job = await getProviderJobForPoll(deps.db, providerJobId);
    if (!job || !job.providerTaskId) return;
    if (job.normalizedStatus !== 'ready') return;
    const music = await deps.getMusic();
    const status = await music.getGenerationStatus(job.providerTaskId);
    if (status.status !== 'complete') {
      throw new Error(
        `process-provider-results: provider reports "${status.status}" for ready job ${job.jobId} — retrying recovery`,
      );
    }
    await runProcessProviderResults(
      {
        db: deps.db,
        encryptionKey,
        enqueueDownload: (trackId) => enqueueDownloadFinalAudio(helpers.addJob, trackId),
        enqueueBuffer: (sessionId) => enqueueBufferRefill(helpers.addJob, sessionId),
      },
      { job, tracks: status.tracks, complete: true },
    );
  };
}
