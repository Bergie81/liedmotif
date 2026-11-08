// Enqueue a Graphile Worker job from OUTSIDE the worker process (the web app),
// via the SQL function the worker schema installs. The generation pipeline stays
// worker-driven (routes write rows, the sweep picks them up) — this exists for
// the small class of jobs a route should kick off directly because no sweep
// watches for them (cover generation at session creation, MP3 retagging on an
// artist-name change). Callers treat it as BEST-EFFORT: the graphile_worker
// schema is installed out-of-band by the worker migrator, so a route must catch
// and log a failure, never surface it — these jobs are cosmetic by contract.

import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../transactions';

/**
 * The buffer-fill job's identity, shared by every producer: the worker's
 * sweep/refill enqueues AND the web app's enqueue-at-session-creation. The
 * creation-time enqueue dedupes against the sweep ONLY because both use
 * exactly this task name and job key — defined once so they cannot drift.
 */
export const SESSION_BUFFER_JOB_IDENTIFIER = 'ensure-session-buffer';
export function sessionBufferJobKey(sessionId: string): string {
  return `buffer:${sessionId}`;
}

/**
 * The Session Cover job's identity, shared by the web's creation-time enqueue
 * and the worker's music-ready kick. Both must use exactly this task name and
 * job key: the default `replace` jobKey mode is what lets the kick reset a
 * backoff-waiting attempt (a standard cover waiting for its first ready music
 * task) to run immediately — or revive one whose attempts ran out.
 */
export const SESSION_COVER_JOB_IDENTIFIER = 'generate-session-cover';
export function sessionCoverJobKey(sessionId: string): string {
  return `cover:${sessionId}`;
}

/**
 * Retry budget for the paid cover-generation job. Wide enough that a
 * music-task-driven cover can wait out the session's first music task
 * (~2–3 min) through Graphile's exponential backoff before the job dies; paid
 * submissions stay bounded separately by the attempt ledger's safe-retry
 * accounting, so extra job attempts never mean extra spend.
 */
export const SESSION_COVER_JOB_MAX_ATTEMPTS = 10;

/**
 * The Playlist cover job's identity (Playlist covers reuse the Session Cover
 * machinery). Regeneration-only, so enqueues append the attempt id to the
 * key — the fixed prefix alone would dedupe unrelated attempts.
 */
export const PLAYLIST_COVER_JOB_IDENTIFIER = 'generate-playlist-cover';
export function playlistCoverJobKey(playlistId: string): string {
  return `playlist-cover:${playlistId}`;
}

/**
 * The one Graphile queue every `embed-track-metadata` job runs in, from both
 * processes. A retag measures the stored tag, then streams the old body from that
 * offset into a rewrite; two retags of one file overlapping would splice the
 * other's new tag in as audio. The per-track job key cannot prevent that: in
 * `replace` mode Graphile clears the key of a RUNNING job and adds a fresh one.
 */
export const TRACK_EMBED_QUEUE_NAME = 'track-embed';

export interface AddWorkerJobOptions {
  /** Stable dedup key (Graphile default `replace` mode). */
  jobKey?: string;
  /** Retry budget for the job (Graphile's default is far too generous for paid work). */
  maxAttempts?: number;
}

/** Enqueue `identifier` with `payload` through `graphile_worker.add_job`. */
export async function addWorkerJob(
  db: DbOrTx,
  identifier: string,
  payload: Record<string, unknown>,
  options: AddWorkerJobOptions = {},
): Promise<void> {
  await db.execute(sql`
    select graphile_worker.add_job(
      ${identifier}::text,
      payload => ${JSON.stringify(payload)}::json,
      job_key => ${options.jobKey ?? null}::text,
      max_attempts => ${options.maxAttempts ?? null}::int
    )
  `);
}

/**
 * Enqueue MANY jobs of one task in a single statement — an artist-name change
 * retags every final MP3, and one round trip per track would block the HTTP
 * request that triggered it for the whole library.
 */
export async function addWorkerJobBatch(
  db: DbOrTx,
  identifier: string,
  jobs: Array<{ payload: Record<string, unknown>; jobKey: string }>,
  queueName: string | null = null,
): Promise<void> {
  if (jobs.length === 0) return;
  const payloads = jobs.map((job) => JSON.stringify(job.payload));
  const jobKeys = jobs.map((job) => job.jobKey);
  await db.execute(sql`
    select graphile_worker.add_job(
      ${identifier}::text,
      payload => j.payload::json,
      job_key => j.job_key,
      queue_name => ${queueName}::text
    )
    from unnest(${sql.param(payloads)}::text[], ${sql.param(jobKeys)}::text[]) as j(payload, job_key)
  `);
}
