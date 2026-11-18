// Provider-job poll reads/writes. The worker's `poll-music-generation`
// job loads a submitted job's context, then records each poll's outcome: the
// normalized status the app reasons about + the raw provider status TOKEN (never a
// URL — provider stream/final URLs are encrypted into `track_audio_assets`, never
// serialized to `provider_jobs`), the next poll time, and the attempt count.
//
// MONEY-SAFETY: a poll must never drive a job that already holds a `providerTaskId`
// back into a paid-submit state, so the write goes through
// `assertNoProviderResubmitAfterTask` — the same guard `markProviderJobSubmitted`
// uses. A poll only ever advances toward `processing`/`partially_ready`/`ready` or a
// terminal failure, so the guard is a backstop, not a normal-path branch.

import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import {
  assertNoProviderResubmitAfterTask,
  LIVE_IN_FLIGHT_PROVIDER_STATUSES,
  LIVE_QUEUE_ITEM_STATES,
  POLL_TERMINAL_PROVIDER_STATUSES,
  type ProviderNormalizedStatus,
  type ProviderType,
} from '@liedmotif/shared';
import type { Database } from '../client';
import { withTransaction } from '../transactions';
import {
  activitySessionQueueItems,
  activitySessions,
  generationRequests,
  providerJobs,
  trackAudioAssets,
  tracks,
} from '../schema';
import type { StyleSnapshot } from '../schema/types';

/** The job context a poll needs to advance the job and (when ready) create tracks. */
export interface ProviderJobForPoll {
  jobId: string;
  providerType: ProviderType;
  providerKey: string;
  /** Null only if the submit never captured a task id — such a job cannot be polled. */
  providerTaskId: string | null;
  normalizedStatus: ProviderNormalizedStatus;
  /** The raw provider status token the LAST poll recorded (null before the first
   *  poll) — what lets a repeat poll recognize it observed nothing new. */
  providerStatus: string | null;
  retryCount: number;
  generationRequestId: string;
  /** Null when the owner was deleted — the request survives as spend ledger. */
  ownerUserId: string | null;
  /** Null when the request outlived its session row (set-null FK). */
  activitySessionId: string | null;
  /**
   * The request's prompt IDENTITY (session-frozen style, else the expansion),
   * written to `tracks.prompt` at materialization. The listener's own prompt
   * history is deliberately NOT a fallback here: it is provenance, and a style
   * identity is what a reroll recompiles. This is the Session's "same
   * prompt" in the domain sense (the reroll/vibe identity) — the per-track text
   * actually submitted additionally carries a hidden seed-picked variation and may
   * be clamped to the provider's per-model caps; the exact submitted body is not
   * persisted.
   */
  prompt: string;
  /** The request's zero-based index within its session (recorded at submit), for
   *  distinct sibling track titles at materialization; null on requests predating
   *  the column. */
  titleSeed: number | null;
  /** How many tracks the request asked the provider for — the STABLE per-request
   *  ordinal multiplier for sibling titling (a partial poll may deliver fewer). */
  requestedTrackCount: number;
  /** The session's frozen Style Snapshot (title pool + title scheme), for display
   *  titles at materialization; null when the session row is gone / has none. */
  sessionSnapshot: StyleSnapshot | null;
  /** The REQUEST's own Style Snapshot — the vibe its tracks were generated under.
   *  Facet stamps at materialization (genre tags) read THIS, never the live
   *  session snapshot, which a Change Vibe rewrites; null on requests predating
   *  the column. */
  requestSnapshot: StyleSnapshot | null;
}

/** Load the joined poll context for one provider job, or null when it is gone. */
export async function getProviderJobForPoll(
  db: Database,
  providerJobId: string,
): Promise<ProviderJobForPoll | null> {
  const [row] = await db
    .select({
      jobId: providerJobs.id,
      providerType: providerJobs.providerType,
      providerKey: providerJobs.providerKey,
      providerTaskId: providerJobs.providerTaskId,
      normalizedStatus: providerJobs.normalizedStatus,
      providerStatus: providerJobs.providerStatus,
      retryCount: providerJobs.retryCount,
      generationRequestId: providerJobs.generationRequestId,
      ownerUserId: generationRequests.ownerUserId,
      activitySessionId: generationRequests.activitySessionId,
      stylePrompt: generationRequests.stylePrompt,
      expandedPrompt: generationRequests.expandedPrompt,
      titleSeed: generationRequests.titleSeed,
      requestedTrackCount: generationRequests.requestedTrackCount,
      sessionSnapshot: activitySessions.sessionStyleSnapshot,
      requestSnapshot: generationRequests.styleSnapshot,
    })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .leftJoin(activitySessions, eq(generationRequests.activitySessionId, activitySessions.id))
    .where(eq(providerJobs.id, providerJobId))
    .limit(1);
  if (!row) return null;
  const { stylePrompt, expandedPrompt, ...rest } = row;
  return { ...rest, prompt: stylePrompt ?? expandedPrompt ?? '' };
}

/**
 * In-flight statuses the safety-net scan re-polls (a lost self-reschedule recovers
 * here) — the shared LIVE bucket: exactly the statuses the poll loop owns advancing.
 */
const POLLABLE_IN_FLIGHT_STATUSES = LIVE_IN_FLIGHT_PROVIDER_STATUSES;

/** The shared poll-terminal bucket, as the CAS guard's value list. */
const TERMINAL_NORMALIZED_STATUSES: ProviderNormalizedStatus[] = [
  ...POLL_TERMINAL_PROVIDER_STATUSES,
];

/**
 * Safety-net scan: provider jobs whose poll loop appears to have stalled —
 * either a `next_poll_at` that has come due (a lost self-reschedule) OR a `submitted`
 * job that never got its first poll scheduled and is now past the grace window (a lost
 * first-poll enqueue). Only jobs that hold a task id and are still in flight are
 * returned; terminal/blocked jobs are never re-polled. The recurring cron enqueues one
 * `poll-music-generation` per id. Oldest-due first, capped by `limit`.
 */
export async function listDuePollJobs(
  db: Database,
  args: { now: Date; stuckSubmittedGraceMs?: number; limit?: number },
): Promise<string[]> {
  const graceMs = args.stuckSubmittedGraceMs ?? 60_000;
  const stuckBefore = new Date(args.now.getTime() - graceMs);
  const rows = await db
    .select({ id: providerJobs.id })
    .from(providerJobs)
    .where(
      and(
        isNotNull(providerJobs.providerTaskId),
        inArray(providerJobs.normalizedStatus, [...POLLABLE_IN_FLIGHT_STATUSES]),
        or(
          lte(providerJobs.nextPollAt, args.now),
          and(
            isNull(providerJobs.nextPollAt),
            eq(providerJobs.normalizedStatus, 'submitted'),
            lte(providerJobs.lastSubmitAttemptAt, stuckBefore),
          ),
        ),
      ),
    )
    // Nulls-last on next_poll_at so the due-by-time jobs are drained before the
    // stuck-submitted ones; both within one capped batch.
    .orderBy(sql`${providerJobs.nextPollAt} asc nulls last`, asc(providerJobs.lastSubmitAttemptAt))
    .limit(args.limit ?? 100);
  return rows.map((r) => r.id);
}

/** How far back the ready-with-missing-tracks recovery scan looks (see below). */
export const READY_MISSING_TRACKS_RECENCY_MS = 6 * 60 * 60_000;

/**
 * Recovery scan: `ready` provider jobs that hold a task id but
 * materialized FEWER tracks than the request asked for (`requestedTrackCount`,
 * NOT NULL, default 2 = Suno's tracks-per-call). `ready` is CAS-written before
 * materialization and each sibling commits in its own transaction, so both the
 * zero-track strand AND a mid-siblings crash (one paid track local, one only at the
 * provider) mean paid audio exists upstream but not locally. The normal healer is
 * the Graphile retry of the crashed poll (which enqueues `process-provider-results`);
 * this scan is the backstop for a retry that never comes (attempts exhausted, job
 * row removed, hard worker death). Bounded to jobs last written within `recencyMs`:
 * older strands predate provider retention, and a completed job whose provider
 * legitimately yielded fewer playable tracks than requested would otherwise be
 * rescanned forever — inside the window that benign case costs only free status
 * reads, then ages out.
 */
export async function listReadyJobsMissingTracks(
  db: Database,
  args: { now: Date; recencyMs?: number; limit?: number },
): Promise<string[]> {
  const since = new Date(args.now.getTime() - (args.recencyMs ?? READY_MISSING_TRACKS_RECENCY_MS));
  const rows = await db
    .select({ id: providerJobs.id })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(
      and(
        isNotNull(providerJobs.providerTaskId),
        eq(providerJobs.normalizedStatus, 'ready'),
        gte(providerJobs.updatedAt, since),
        // A deleted owner's Tracks cascaded away and nothing materializes for
        // nobody, so the job would only cost a status read every minute.
        isNotNull(generationRequests.ownerUserId),
        sql`(${generationRequests.status} = 'awaiting_results' or (select count(*) from ${tracks} where ${tracks.providerJobId} = ${providerJobs.id}) < ${generationRequests.requestedTrackCount})`,
      ),
    )
    .orderBy(asc(providerJobs.updatedAt))
    .limit(args.limit ?? 100);
  return rows.map((r) => r.id);
}

/**
 * How long after a job timed out its stream-only Tracks keep being offered a
 * late final. The provider retains finals for 15 days, but a task still
 * unfinished a day after its poll budget ran out is not going to finish; inside
 * the window the cost is one free status read per job per sweep.
 */
export const TERMINAL_JOB_SALVAGE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Jobs whose poll budget ran out after the stream stage: `failed_final` with a
 * progress token as the last provider status (a provider-reported failure
 * records `failed` and never delivers a final), still owning a live
 * stream-only Track. Their task may still complete upstream, and nothing else
 * reads it again. Most recently terminalized first: those are the likeliest to
 * finish.
 */
export async function listTimedOutJobsAwaitingFinals(
  db: Database,
  args: { now: Date; windowMs?: number; limit?: number },
): Promise<string[]> {
  const since = new Date(args.now.getTime() - (args.windowMs ?? TERMINAL_JOB_SALVAGE_WINDOW_MS));
  const rows = await db
    .select({ id: providerJobs.id })
    .from(providerJobs)
    .where(
      and(
        isNotNull(providerJobs.providerTaskId),
        eq(providerJobs.normalizedStatus, 'failed_final'),
        sql`${providerJobs.providerStatus} <> 'failed'`,
        gte(providerJobs.updatedAt, since),
        sql`exists (
          select 1 from ${tracks}
          where ${tracks.providerJobId} = ${providerJobs.id}
            and ${tracks.status} = 'streamable'
            and ${tracks.dislikedAt} is null
            and not exists (select 1 from ${trackAudioAssets} a
              where a.track_id = ${tracks.id} and a.asset_type = 'provider_final')
        )`,
      ),
    )
    .orderBy(desc(providerJobs.updatedAt))
    .limit(args.limit ?? 20);
  return rows.map((r) => r.id);
}

/** Provider track ids of the job's live Tracks: the only rows a late final may enrich. */
export async function listLiveProviderTrackIds(
  db: Database,
  providerJobId: string,
): Promise<string[]> {
  const rows = await db
    .select({ providerTrackId: tracks.providerTrackId })
    .from(tracks)
    .where(
      and(
        eq(tracks.providerJobId, providerJobId),
        inArray(tracks.status, ['streamable', 'ready']),
        isNull(tracks.dislikedAt),
      ),
    );
  return rows.flatMap((r) => (r.providerTrackId ? [r.providerTrackId] : []));
}

/**
 * How many of a job's tracks already hold a durable provider stream / final
 * asset. A repeat poll compares these against what the provider reported to
 * decide whether materialization has anything to do at all: with the provider
 * status token unchanged and no URL beyond what is already sealed at rest, the
 * poll is a no-op and skips the per-track upsert transactions entirely (one
 * cheap read instead of N write transactions + the session-row cutover lock).
 */
export async function countProviderJobUrlAssets(
  db: Database,
  providerJobId: string,
): Promise<{ streams: number; finals: number }> {
  const [row] = await db
    .select({
      streams: sql<number>`count(*) filter (where ${trackAudioAssets.assetType} = 'provider_stream')`,
      finals: sql<number>`count(*) filter (where ${trackAudioAssets.assetType} = 'provider_final')`,
    })
    .from(trackAudioAssets)
    .innerJoin(tracks, eq(trackAudioAssets.trackId, tracks.id))
    .where(eq(tracks.providerJobId, providerJobId));
  return { streams: Number(row?.streams ?? 0), finals: Number(row?.finals ?? 0) };
}

export interface UpdateProviderJobPollStateInput {
  jobId: string;
  /** The raw provider status TOKEN only (e.g. `complete`/`failed`) — never a URL. */
  providerStatus: string;
  normalizedStatus: ProviderNormalizedStatus;
  /** When to poll next, or null once the job is terminal / fully downloadable. */
  nextPollAt: Date | null;
  retryCount: number;
}

/**
 * Record the outcome of one poll as a COMPARE-AND-SET: the write lands only while the
 * job is still in a non-terminal status, so a late/overlapping poll carrying a stale
 * snapshot can never regress a job another poll already drove terminal. Returns whether
 * a row was actually updated — the caller MUST abort (no materialization, no reschedule)
 * when it was not. `updatedAt` is bumped by Drizzle's `$onUpdate` so the buffer
 * controller's stall detection sees fresh progress; the resubmit guard still rejects a
 * paid-submit-state write for a job that already holds a task id.
 */
export async function updateProviderJobPollState(
  db: Database,
  input: UpdateProviderJobPollStateInput,
): Promise<{ updated: boolean }> {
  const [existing] = await db
    .select({ providerTaskId: providerJobs.providerTaskId })
    .from(providerJobs)
    .where(eq(providerJobs.id, input.jobId))
    .limit(1);
  assertNoProviderResubmitAfterTask(existing?.providerTaskId != null, input.normalizedStatus);

  const updated = await db
    .update(providerJobs)
    .set({
      providerStatus: input.providerStatus,
      normalizedStatus: input.normalizedStatus,
      nextPollAt: input.nextPollAt,
      retryCount: input.retryCount,
    })
    .where(
      and(
        eq(providerJobs.id, input.jobId),
        notInArray(providerJobs.normalizedStatus, TERMINAL_NORMALIZED_STATUSES),
      ),
    )
    .returning({ id: providerJobs.id });
  return { updated: updated.length > 0 };
}

/**
 * Bump only the poll attempt counter + next poll time, leaving `normalizedStatus`
 * exactly as-is. Used on a TRANSIENT transport error (the status call threw before a
 * status could be read): the job stays in its in-flight status — so the buffer
 * controller keeps counting it and never blocks the session on a blip — while the
 * poll backs off and retries. Status-free by design, so it does not (and must not)
 * go through the resubmit guard.
 */
export async function bumpProviderJobPollAttempt(
  db: Database,
  input: { jobId: string; retryCount: number; nextPollAt: Date | null },
): Promise<void> {
  await db
    .update(providerJobs)
    .set({ retryCount: input.retryCount, nextPollAt: input.nextPollAt })
    .where(eq(providerJobs.id, input.jobId));
}

/**
 * A provider-reported failure means the job's missing finals never come: its
 * live Tracks holding no final at all — neither a stored local one nor a
 * provider final still to download — become `failed`, and their live Queue
 * slots `failed` with them, so neither the Queue nor the buffer counts them
 * again. Their stream assets are left as they are: a Track playing right now
 * plays to its end through the audio route. A Disliked or deleted Track keeps
 * its status. Returns the ids actually failed.
 */
export async function failFinalLessTracksOfJob(
  db: Database,
  providerJobId: string,
): Promise<{ failedTrackIds: string[] }> {
  return withTransaction(db, async (tx) => {
    const failed = await tx
      .update(tracks)
      .set({ status: 'failed' })
      .where(
        and(
          eq(tracks.providerJobId, providerJobId),
          inArray(tracks.status, ['pending', 'streamable']),
          isNull(tracks.dislikedAt),
          sql`not exists (select 1 from ${trackAudioAssets} a
            where a.track_id = ${tracks.id}
              and a.asset_type in ('provider_final', 'local_original'))`,
        ),
      )
      .returning({ id: tracks.id });
    const failedTrackIds = failed.map((row) => row.id);
    if (failedTrackIds.length > 0) {
      await tx
        .update(activitySessionQueueItems)
        .set({ state: 'failed' })
        .where(
          and(
            inArray(activitySessionQueueItems.trackId, failedTrackIds),
            inArray(activitySessionQueueItems.state, [...LIVE_QUEUE_ITEM_STATES]),
          ),
        );
    }
    return { failedTrackIds };
  });
}

/**
 * Mark a generation request failed with a sanitized error code + safe message (set
 * by the poll job when the provider reports a terminal failure). The raw provider
 * error text never lands here — only the vendor-neutral failure category.
 */
export async function markGenerationRequestFailed(
  db: Database,
  input: { generationRequestId: string; errorCode: string; errorMessageSafe: string },
): Promise<void> {
  await db
    .update(generationRequests)
    .set({
      status: 'failed',
      errorCode: input.errorCode,
      errorMessageSafe: input.errorMessageSafe,
    })
    .where(eq(generationRequests.id, input.generationRequestId));
}
