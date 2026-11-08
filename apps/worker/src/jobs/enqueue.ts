// Centralized Graphile follow-up enqueues for the generation pipeline.
//
// The task identifiers, the stable dedup `jobKey`s, and their `jobKeyMode` are the
// concurrency contract of the pipeline (e.g. `download:<trackId>` collapses repeated
// download enqueues to one pending per track; `poll:<providerJobId>` serializes the
// poll loop). Defining each in ONE place — rather than re-typing the same string in
// every task wrapper — keeps a typo in one wrapper from silently breaking dedup or
// recovery, and documents the whole follow-up graph in a single readable surface.

import {
  SESSION_BUFFER_JOB_IDENTIFIER,
  SESSION_COVER_JOB_IDENTIFIER,
  SESSION_COVER_JOB_MAX_ATTEMPTS,
  sessionBufferJobKey,
  sessionCoverJobKey,
  TRACK_EMBED_QUEUE_NAME,
} from '@liedmotif/db';
import { CURRENT_ANALYSIS_VERSION } from '@liedmotif/shared';
import type { AddJobFunction } from 'graphile-worker';

/**
 * Attempt ceiling for the CPU-heavy track analysis. The admin's
 * `maxRetriesPerJob` cost control counts RETRIES, the attempts after the
 * first, and can only tighten this bound, never loosen it; one attempt always
 * runs.
 *
 * Analysis is the one budget in the pipeline that exists to absorb FAILURE, so
 * it is the one the control caps. The poll loop's 48 attempts and the cover
 * job's 10 pace PROGRESS instead — one against provider retention, the other
 * waiting out the session's first music task through Graphile's backoff — and
 * capping those would abandon paid work rather than bound a retry storm.
 */
const ANALYSIS_JOB_MAX_ATTEMPTS = 3;

/** Download a track's final audio. Deduped to at most one pending download per track. */
export async function enqueueDownloadFinalAudio(
  addJob: AddJobFunction,
  trackId: string,
): Promise<void> {
  await addJob('download-final-audio', { trackId }, { jobKey: `download:${trackId}` });
}

/**
 * Kick a session's cover job. Shares the web enqueue's exact job identity, so
 * the default `replace` jobKey mode resets a backoff-waiting attempt (a
 * standard cover waiting for its first ready music task) to run immediately —
 * or revives one whose attempts ran out.
 */
export async function enqueueSessionCoverKick(
  addJob: AddJobFunction,
  args: { ownerUserId: string; activitySessionId: string },
): Promise<void> {
  await addJob(SESSION_COVER_JOB_IDENTIFIER, args, {
    jobKey: sessionCoverJobKey(args.activitySessionId),
    maxAttempts: SESSION_COVER_JOB_MAX_ATTEMPTS,
  });
}

/**
 * Re-evaluate a session's buffer. `unsafe_dedupe`: an already-queued refill absorbs
 * the enqueue, so the (frequent) callers coalesce onto it instead of pulling it
 * earlier — and a refill that keeps failing keeps its attempts and its backoff.
 * The every-minute sweep drives this same enqueue, so `replace`/`preserve_run_at`
 * (both of which always reset `attempts` to zero) would re-arm a broken refill
 * once a minute forever: backoff flattened, `max_attempts` unreachable, the job
 * counted runnable rather than failed. A refill that does run out of attempts
 * stays stopped for the cron but is revived by the web app's own `replace`-mode
 * enqueue, which every session action (start, resume, play, Change Vibe, mode)
 * issues under this same job key.
 */
export async function enqueueBufferRefill(
  addJob: AddJobFunction,
  sessionId: string,
): Promise<void> {
  await addJob(
    SESSION_BUFFER_JOB_IDENTIFIER,
    { sessionId },
    { jobKey: sessionBufferJobKey(sessionId), jobKeyMode: 'unsafe_dedupe' },
  );
}

/**
 * Measure a downloaded track (runs after the local audio lands). The contract:
 *  - VERSIONED job key: a re-analysis for a new analyzer version never
 *    collides with (or resets) a pending job for the old one;
 *  - a dedicated SERIALIZED queue: at most one CPU-heavy analysis at a time,
 *    so the pool keeps slots free for provider polling (the estimator itself
 *    additionally runs in a worker thread);
 *  - `ANALYSIS_JOB_MAX_ATTEMPTS`, tightened by the admin's retry cap (not
 *    Graphile's default 25) — the job
 *    records `failed` after the last attempt;
 *  - `unsafe_dedupe` (not the default `replace`): the recurring backfill
 *    sweep re-selects a track until its analysis write lands, so it re-issues
 *    this enqueue while the job is still pending/retrying — `replace` would
 *    zero the retry state (and steal a LOCKED job's key, letting a second
 *    analysis run), exactly the failure mode documented for the recovery
 *    enqueue below. With dedupe, an existing job keeps its attempts/backoff;
 *    a COMPLETED job is gone from the queue, so re-analysis after the
 *    boot-probe reset enqueues fresh.
 */
export async function enqueueAnalyzeTrack(
  addJob: AddJobFunction,
  trackId: string,
  maxRetriesPerJob: number,
): Promise<void> {
  await addJob(
    'analyze-track-bpm-key',
    { trackId },
    {
      jobKey: `analyze:v${CURRENT_ANALYSIS_VERSION}:${trackId}`,
      jobKeyMode: 'unsafe_dedupe',
      queueName: 'track-analysis',
      maxAttempts: Math.max(1, Math.min(ANALYSIS_JOB_MAX_ATTEMPTS, maxRetriesPerJob + 1)),
    },
  );
}

/**
 * (Re)write a local final MP3's ID3 metadata (Session Cover + title/album/artist).
 * Deduped to one pending embed per track; the job itself is idempotent via its
 * `TXXX` tag-state marker, so the enqueue sites never need to know what changed.
 */
export async function enqueueEmbedTrackMetadata(
  addJob: AddJobFunction,
  trackId: string,
): Promise<void> {
  await addJob(
    'embed-track-metadata',
    { trackId },
    { jobKey: `embed:${trackId}`, queueName: TRACK_EMBED_QUEUE_NAME },
  );
}

/**
 * Re-materialize a provider job's tracks from a fresh server-side status read. The
 * recovery producer for a job CAS'd `ready` whose materialization crashed (the poll
 * writes the terminal status first).
 *
 * `unsafe_dedupe` (not the default `replace`): the producers SEED the recovery, they
 * must never reset it. The safety-net cron re-enqueues every still-stranded job each
 * minute, and `replace` would zero the existing job's attempts and pull `run_at` to
 * now — flattening the exponential backoff of a recovery that keeps throwing into a
 * once-a-minute hammer. With dedupe, an existing pending/retrying recovery keeps its
 * retry state, and one that permanently failed stays stopped (visible via
 * `last_error`) instead of being revived every minute; a COMPLETED job is removed
 * from the queue, so a genuinely new need enqueues fresh.
 */
export async function enqueueProcessProviderResults(
  addJob: AddJobFunction,
  providerJobId: string,
): Promise<void> {
  await addJob(
    'process-provider-results',
    { providerJobId },
    { jobKey: `process:${providerJobId}`, jobKeyMode: 'unsafe_dedupe' },
  );
}

/** (Re)schedule a job's status poll at a specific time — the first poll and each backoff. */
export async function enqueuePollAt(
  addJob: AddJobFunction,
  providerJobId: string,
  runAt: Date,
): Promise<void> {
  await addJob(
    'poll-music-generation',
    { providerJobId },
    { jobKey: `poll:${providerJobId}`, runAt },
  );
}

/**
 * Ensure a status poll exists for a job WITHOUT disturbing an already-scheduled
 * one — the safety-net cron's "recover a lost poll" enqueue. `unsafe_dedupe` for
 * the same reason as the recovery producer above: this runs every minute, so it
 * must SEED a missing poll and otherwise leave the existing one — its `run_at`,
 * its attempts, its backoff — exactly as the poll loop scheduled it.
 */
export async function enqueuePollPreservingSchedule(
  addJob: AddJobFunction,
  providerJobId: string,
): Promise<void> {
  await addJob(
    'poll-music-generation',
    { providerJobId },
    { jobKey: `poll:${providerJobId}`, jobKeyMode: 'unsafe_dedupe' },
  );
}
