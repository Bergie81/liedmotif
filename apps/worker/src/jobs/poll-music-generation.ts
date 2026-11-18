// `poll-music-generation`. The bridge from a SUBMITTED provider job to
// playable tracks: it polls the provider for status (FREE — never `createGenerationTask`,
// never a paid call), maps the vendor-neutral lifecycle onto the DB normalized status,
// records the outcome (status token + next poll time — NEVER a URL), materializes any
// ready tracks via `process-provider-results`, and reschedules itself with backoff
// until the job is terminal or the attempt cap is hit.
//
// IDEMPOTENCY (the readiness analog of the submit path's money safety): polls run repeatedly
// (Graphile retries + the self-rescheduling loop, serialized per job by `poll:<jobId>`).
//   - A re-poll of a TERMINAL job (ready / failed_final / a block / submit_unknown) is
//     an immediate no-op — the provider is never called again. Exception: a re-poll of
//     a READY job enqueues `process-provider-results` (which re-reads status
//     server-side), because `ready` is CAS-written BEFORE materialization — a crash
//     between the two would otherwise strand the paid tracks forever.
//   - Track/asset/queue materialization is idempotent in the repo layer, so two polls
//     observing the same tracks create exactly one row of each.
// MONEY-SAFETY: the DB write goes through the resubmit guard
// (`updateProviderJobPollState`) — a job holding a task id can never be driven back to
// a paid-submit state. A transient transport blip never demotes the job's status (which
// would wrongly block the session); it just backs off and retries.

import type { Database } from '@liedmotif/db';
import {
  bumpProviderJobPollAttempt,
  countProviderJobUrlAssets,
  failFinalLessTracksOfJob,
  getActiveSession,
  getProviderJobForPoll,
  getSessionById,
  markGenerationRequestFailed,
  PLACEHOLDER_COVER_ID,
  updateProviderJobPollState,
  type ProviderJobForPoll,
} from '@liedmotif/db';
import type {
  MusicFailureReason,
  MusicProvider,
  NormalizedTrack,
  ProviderJobStatus,
} from '@liedmotif/providers';
import { POLL_TERMINAL_PROVIDER_STATUSES } from '@liedmotif/shared';
import type { LogFields, ProviderNormalizedStatus } from '@liedmotif/shared';
import type { Task } from 'graphile-worker';
import { requireEncryptionKey } from './encryption-key';
import {
  enqueueBufferRefill,
  enqueueDownloadFinalAudio,
  enqueuePollAt,
  enqueueProcessProviderResults,
  enqueueSessionCoverKick,
} from './enqueue';
import { runProcessProviderResults } from './process-provider-results';

/** Default gap between polls — within the provider's ~30-40s stream / 2-3min final window. */
export const DEFAULT_POLL_INTERVAL_MS = 12_000;
/** Default attempt cap (~7-10 min depending on cadence mix) — bounded by provider retention. */
export const DEFAULT_MAX_POLL_ATTEMPTS = 48;
/**
 * Cold-start cadence: until the FIRST track is COMPLETE the job is what the
 * player's cold-start UX is waiting on — first the stream URL that lets
 * playback begin at all (the stream proxy is the cold-start
 * floor), then the track's duration (the provider reports one only for a
 * finished track), which is what turns the unknown-length progress bar into
 * a real, scrubbable one. So poll fast until a completed track appears, then
 * relax to the default. Bounded to the first `COLD_START_FAST_POLL_LIMIT`
 * attempts (covering ~2 min past the first poll) so a stalled job spends the
 * rest of its budget at the default cadence instead of burning it 5s at a
 * time. Even the fast cadence is one FREE status call per 5s per job — far
 * below the provider's 20 req / 10s limit.
 */
export const COLD_START_POLL_INTERVAL_MS = 5_000;
export const COLD_START_FAST_POLL_LIMIT = 24;

/** Membership form of the shared poll-terminal bucket (this job tests it per poll). */
const TERMINAL_STATUSES: ReadonlySet<ProviderNormalizedStatus> = new Set(
  POLL_TERMINAL_PROVIDER_STATUSES,
);

/** Map the provider's progress lifecycle to the DB normalized status. */
const PROGRESS_TO_NORMALIZED: Record<
  Exclude<ProviderJobStatus, 'failed'>,
  Extract<ProviderNormalizedStatus, 'processing' | 'partially_ready' | 'ready'>
> = {
  pending: 'processing',
  text_ready: 'processing',
  first_track_ready: 'partially_ready',
  complete: 'ready',
};

/** Map a sanitized failure reason to a terminal normalized status + safe error fields. */
function mapFailure(reason: MusicFailureReason): {
  normalizedStatus: ProviderNormalizedStatus;
  errorCode: string;
  errorMessageSafe: string;
} {
  switch (reason) {
    case 'insufficient_credit':
      return {
        normalizedStatus: 'blocked_by_provider_credits',
        errorCode: 'insufficient_credit',
        errorMessageSafe: 'The music provider is out of credits.',
      };
    case 'sensitive_content':
      return {
        normalizedStatus: 'blocked_by_policy',
        errorCode: 'sensitive_content',
        errorMessageSafe: 'This request was blocked by the music provider’s content policy.',
      };
    case 'generation_failed':
    case 'unknown':
    default:
      return {
        normalizedStatus: 'failed_final',
        errorCode: 'generation_failed',
        errorMessageSafe: 'Music generation failed. Try again or adjust the request.',
      };
  }
}

export interface PollMusicGenerationDeps {
  db: Database;
  music: Pick<MusicProvider, 'getGenerationStatus'>;
  /** AES-256-GCM key sealing provider stream/final URLs at rest (passed to processing). */
  encryptionKey: Buffer;
  now?: Date;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  /** Re-enqueue this poll at `runAt` (Graphile `addJob`, keyed `poll:<jobId>`). */
  reschedulePoll: (providerJobId: string, runAt: Date) => Promise<void>;
  enqueueDownload: (trackId: string) => Promise<void>;
  enqueueBuffer: (sessionId: string) => Promise<void>;
  /** Enqueue the `process-provider-results` recovery run for an already-`ready` job. */
  enqueueProcessResults: (providerJobId: string) => Promise<void>;
  /** Kick the session's cover job (a standard cover waits for ready music). */
  enqueueSessionCover: (args: { ownerUserId: string; activitySessionId: string }) => Promise<void>;
  /** Diagnostics sink (Graphile's logger in production): one secret-free line per
   * poll — provider status + per-track field PRESENCE, never URLs. This is the
   * only record of what each poll saw (poll responses are deliberately not
   * persisted), so it is what distinguishes "the provider offered no stream
   * mid-flight" from an app-side stall after the fact. */
  info?: (message: string, fields?: LogFields) => void;
}

export interface PollMusicGenerationPayload {
  providerJobId: string;
}

export type PollOutcome =
  | 'missing'
  | 'no_task_id'
  | 'already_terminal'
  | 'advanced'
  | 'failed'
  // The poll attempt cap was hit on a still-non-terminal job → terminalized as a timeout.
  | 'timed_out'
  // A concurrent poll drove the job terminal first; this stale poll's write lost the CAS.
  | 'superseded'
  | 'transport_error';

/** Sanitized error fields for a job that exhausted its poll budget without finishing. */
const TIMEOUT_FAILURE = {
  errorCode: 'generation_timeout',
  errorMessageSafe: 'Music generation timed out. Try again or adjust the request.',
} as const;

export interface PollMusicGenerationResult {
  outcome: PollOutcome;
  normalizedStatus?: ProviderNormalizedStatus;
  rescheduled: boolean;
  attempt: number;
  processedTrackIds?: string[];
}

export async function runPollMusicGeneration(
  deps: PollMusicGenerationDeps,
  payload: PollMusicGenerationPayload,
): Promise<PollMusicGenerationResult> {
  const now = deps.now ?? new Date();
  const maxAttempts = deps.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;

  const job = await getProviderJobForPoll(deps.db, payload.providerJobId);
  if (!job) return { outcome: 'missing', rescheduled: false, attempt: 0 };
  // The owner was deleted mid-flight (Member delete): the request
  // row survives as spend ledger with a null owner, but there is nobody to
  // materialize tracks for — writing them would violate the tracks owner FK.
  // Only a poll ever terminalizes a live job, and a live status holds a
  // Members Pool concurrency slot with no age bound, so the job is closed here
  // without polling. Spend stays counted by its submit state.
  if (job.ownerUserId === null) {
    await updateProviderJobPollState(deps.db, {
      jobId: job.jobId,
      providerStatus: 'owner_deleted',
      normalizedStatus: 'failed_final',
      nextPollAt: null,
      retryCount: job.retryCount,
    });
    return { outcome: 'missing', rescheduled: false, attempt: 0 };
  }
  const { ownerUserId } = job;
  // A job that never captured a task id (submit_unknown) cannot be polled.
  if (!job.providerTaskId)
    return { outcome: 'no_task_id', rescheduled: false, attempt: job.retryCount };
  // Re-polling a terminal job is a no-op — the provider is never called again. But a
  // poll only re-runs on an already-`ready` job when a previous attempt threw AFTER
  // the terminal CAS (materialization/enqueue crash — the tracks are paid for but may
  // not exist yet), so hand that job to `process-provider-results` to self-heal; its
  // materialization is idempotent, making a rare redundant run harmless.
  // Likewise a provider-reported failure fails its final-less Tracks only after
  // its CAS, so a retry of a poll that died in between repeats that idempotent
  // write; otherwise those Tracks would stay offered for play on a dead stream.
  if (TERMINAL_STATUSES.has(job.normalizedStatus)) {
    if (job.normalizedStatus === 'ready') await deps.enqueueProcessResults(job.jobId);
    if (job.providerStatus === 'failed') {
      const { failedTrackIds } = await failFinalLessTracksOfJob(deps.db, job.jobId);
      if (failedTrackIds.length > 0) await wakeOwnerActiveSession(deps, ownerUserId);
    }
    return {
      outcome: 'already_terminal',
      normalizedStatus: job.normalizedStatus,
      rescheduled: false,
      attempt: job.retryCount,
    };
  }

  const attempt = job.retryCount + 1;
  const canRescheduleMore = attempt < maxAttempts;
  /** The next poll time: an explicit `pollIntervalMs` wins outright (tests);
   * otherwise the cold-start cadence while no COMPLETE track exists yet, the
   * default once one does. */
  const nextPollAtFor = (coldStart: boolean): Date => {
    const intervalMs =
      deps.pollIntervalMs ??
      (coldStart && attempt <= COLD_START_FAST_POLL_LIMIT
        ? COLD_START_POLL_INTERVAL_MS
        : DEFAULT_POLL_INTERVAL_MS);
    return new Date(now.getTime() + intervalMs);
  };

  /**
   * Terminalize a job that can make no further progress (a terminal provider failure,
   * or the poll budget exhausted) as a COMPARE-AND-SET: only the poll that still sees a
   * non-terminal job wins; a stale poll that lost the race returns `superseded` without
   * failing the request twice or re-firing the buffer.
   */
  async function terminalize(
    providerStatus: string,
    normalizedStatus: ProviderNormalizedStatus,
    failure: { errorCode: string; errorMessageSafe: string },
    outcome: 'failed' | 'timed_out',
    keepTracks: NormalizedTrack[] = [],
  ): Promise<PollMusicGenerationResult> {
    const cas = await updateProviderJobPollState(deps.db, {
      jobId: job!.jobId,
      providerStatus,
      normalizedStatus,
      nextPollAt: null,
      retryCount: attempt,
    });
    if (!cas.updated) return { outcome: 'superseded', rescheduled: false, attempt };
    await markGenerationRequestFailed(deps.db, {
      generationRequestId: job!.generationRequestId,
      errorCode: failure.errorCode,
      errorMessageSafe: failure.errorMessageSafe,
    });
    // The CAS already took the job out of the in-flight count, so its Tracks
    // must exist before the wake: a refill in between would see the batch's
    // supply gone and buy another. Materializing after the CAS keeps a stale
    // poll that lost the race from writing anything.
    if (keepTracks.length > 0) {
      await runProcessProviderResults(deps, { job: job!, tracks: keepTracks, complete: false });
    }
    // A provider-reported failure never delivers the finals still missing, so
    // those Tracks fail before the wake: a refill must not count them as ready.
    // A timeout keeps them, because its task may still finish upstream.
    if (outcome === 'failed') await failFinalLessTracksOfJob(deps.db, job!.jobId);
    await wakeOwnerActiveSession(deps, ownerUserId);
    return { outcome, normalizedStatus, rescheduled: false, attempt };
  }

  // Poll (free). A thrown call is a transient transport blip: back off + retry WITHOUT
  // touching the status, so the session is never blocked on a momentary failure — unless
  // the budget is now exhausted, in which case it terminalizes as a timeout (never left
  // stranded non-terminal with no next poll).
  let status;
  try {
    status = await deps.music.getGenerationStatus(job.providerTaskId);
  } catch {
    deps.info?.('music poll transport error', {
      providerJobId: job.jobId,
      attempt,
      willRetry: canRescheduleMore,
    });
    if (!canRescheduleMore) {
      return terminalize('poll_error', 'failed_final', TIMEOUT_FAILURE, 'timed_out');
    }
    // The persisted status is the best cold-start signal available here:
    // `partially_ready` is exactly "the first track completed". A completion
    // that landed in the same poll that blipped just polls fast once more —
    // free and attempt-bounded.
    const nextPollAt = nextPollAtFor(job.normalizedStatus !== 'partially_ready');
    await bumpProviderJobPollAttempt(deps.db, {
      jobId: job.jobId,
      retryCount: attempt,
      nextPollAt,
    });
    await deps.reschedulePoll(job.jobId, nextPollAt);
    return {
      outcome: 'transport_error',
      normalizedStatus: job.normalizedStatus,
      rescheduled: true,
      attempt,
    };
  }

  // A duration lands only with a COMPLETE track, so this same count answers the
  // cold-start question below.
  const withDuration = status.tracks.filter(
    (track) => typeof track.durationSeconds === 'number',
  ).length;
  const withStream = status.tracks.filter((track) => track.streamAudioUrl).length;
  const withFinal = status.tracks.filter((track) => track.audioUrl).length;
  deps.info?.('music poll observed', {
    providerJobId: job.jobId,
    attempt,
    providerStatus: status.status,
    trackCount: status.tracks.length,
    withStream,
    withFinal,
    withDuration,
  });

  // Terminal failure reported by the provider → CAS-terminalize; any Tracks the
  // stream stage materialized without a final fail with it.
  if (status.status === 'failed') {
    const failure = mapFailure(status.failureReason ?? 'unknown');
    return terminalize('failed', failure.normalizedStatus, failure, 'failed');
  }

  const normalizedStatus = PROGRESS_TO_NORMALIZED[status.status];
  const isComplete = normalizedStatus === 'ready';
  // The attempt cap on a still-non-terminal job is NOT "stop polling and hope" — it
  // terminalizes as a timeout so the session surfaces the stall instead of hanging.
  if (!isComplete && !canRescheduleMore) {
    // Tracks this last poll saw are paid for: keep them even though the job
    // stops being polled.
    return terminalize(
      status.status,
      'failed_final',
      TIMEOUT_FAILURE,
      'timed_out',
      withStream + withFinal > 0 ? status.tracks : [],
    );
  }
  const willReschedule = !isComplete;
  // Cold start is judged on what THIS poll saw: it ends with the first
  // COMPLETE track — the provider reports a duration only for a finished
  // track, and that duration is what makes the player's progress bar real.
  const nextPollAt = nextPollAtFor(withDuration === 0);

  const observedNewResults = await pollObservedNewResults(deps.db, job, {
    providerStatus: status.status,
    normalizedStatus,
    withStream,
    withFinal,
  });

  // CAS the progress/ready write BEFORE materializing, so a poll that lost the race to a
  // concurrent terminalization does NOT resurrect the job or create tracks after it.
  const cas = await updateProviderJobPollState(deps.db, {
    jobId: job.jobId,
    providerStatus: status.status,
    normalizedStatus,
    nextPollAt: willReschedule ? nextPollAt : null,
    retryCount: attempt,
  });
  if (!cas.updated) return { outcome: 'superseded', normalizedStatus, rescheduled: false, attempt };

  // Materialize whatever tracks the provider has so far (stream-only at TEXT_SUCCESS →
  // cold-start; final at SUCCESS → download). Idempotent in the repo layer; it also
  // enqueues the per-final downloads and a buffer refill (only on real transitions).
  let processedTrackIds: string[] = [];
  if (observedNewResults || isComplete) {
    const processed = await runProcessProviderResults(deps, {
      job,
      tracks: status.tracks,
      complete: isComplete,
    });
    processedTrackIds = processed.processedTrackIds;
  }

  if (willReschedule) await deps.reschedulePoll(job.jobId, nextPollAt);
  if (isComplete) await wakeOwnerActiveSession(deps, ownerUserId);
  // A just-completed task is what a waiting STANDARD cover derives from: kick
  // the cover job now instead of letting its retry backoff idle for minutes.
  if (isComplete && job.activitySessionId) {
    await kickStandardCoverIfWaiting(deps, job.ownerUserId, job.activitySessionId);
  }

  return {
    outcome: 'advanced',
    normalizedStatus,
    rescheduled: willReschedule,
    attempt,
    processedTrackIds,
  };
}

/**
 * Whether this poll saw movement worth materializing. Most polls observe
 * exactly what the previous one did (the 5s cold-start cadence outpaces the
 * provider), and materialization would be a pile of no-op write transactions
 * then — so it runs only on a status-token change, or on a stream/final URL
 * beyond what is already sealed into durable assets (one cheap read answers
 * that). New URLs CAN land under an unchanged token, e.g. a sibling's stream
 * trickling in, which is why the token check alone is not enough.
 */
async function pollObservedNewResults(
  db: Database,
  job: ProviderJobForPoll,
  observed: {
    providerStatus: string;
    normalizedStatus: ProviderNormalizedStatus;
    withStream: number;
    withFinal: number;
  },
): Promise<boolean> {
  const statusUnchanged =
    observed.providerStatus === job.providerStatus &&
    observed.normalizedStatus === job.normalizedStatus;
  if (!statusUnchanged) return true;
  if (observed.withStream + observed.withFinal === 0) return false;
  const durable = await countProviderJobUrlAssets(db, job.jobId);
  return observed.withStream > durable.streams || observed.withFinal > durable.finals;
}

/**
 * A job leaving the in-flight set frees one of its owner's concurrency slots,
 * and the Session waiting for that slot need not be the job's own: a superseded
 * Session's batch outlives the hop while the owner's Active Session's first fill
 * waits for it. An owner has at most one Active Session, and it is the one to wake.
 */
async function wakeOwnerActiveSession(
  deps: PollMusicGenerationDeps,
  ownerUserId: string,
): Promise<void> {
  const active = await getActiveSession(deps.db, { ownerUserId });
  if (active) await deps.enqueueBuffer(active.id);
}

/**
 * Reset a standard-cover session's waiting cover job to run now. Only while the
 * session still wears the placeholder (or nothing): a landed or styled cover
 * means no attempt is waiting on music. Best-effort — on any failure the cover
 * job's own backoff and the aged recovery scan still converge.
 */
async function kickStandardCoverIfWaiting(
  deps: PollMusicGenerationDeps,
  ownerUserId: string,
  activitySessionId: string,
): Promise<void> {
  try {
    const session = await getSessionById(deps.db, { ownerUserId, sessionId: activitySessionId });
    if (!session?.useStandardCover) return;
    if (session.coverImageId !== null && session.coverImageId !== PLACEHOLDER_COVER_ID) return;
    await deps.enqueueSessionCover({ ownerUserId, activitySessionId });
  } catch {
    // cosmetic — the cover pipeline recovers on its own cadence
  }
}

/** Bind to Graphile, serializing the poll loop per job with `poll:<jobId>`. */
export function createPollMusicGenerationTask(deps: {
  db: Database;
  getMusic: () => Promise<MusicProvider>;
  encryptionKey: Buffer | null;
}): Task {
  return async (payload, helpers) => {
    const encryptionKey = requireEncryptionKey(deps.encryptionKey);
    await runPollMusicGeneration(
      {
        db: deps.db,
        // Resolved inside the status call, so a provider that cannot be built (no
        // key, a stored key that fails to decrypt) fails like a transport error:
        // the attempt counts and the cap still ends the job. Failing the Graphile
        // job instead would count nothing and, once its retries ran out, leave
        // the job live for good — holding its owner's concurrency slot.
        music: {
          getGenerationStatus: async (taskId) =>
            (await deps.getMusic()).getGenerationStatus(taskId),
        },
        encryptionKey,
        reschedulePoll: (providerJobId, runAt) =>
          enqueuePollAt(helpers.addJob, providerJobId, runAt),
        enqueueDownload: (trackId) => enqueueDownloadFinalAudio(helpers.addJob, trackId),
        enqueueBuffer: (sessionId) => enqueueBufferRefill(helpers.addJob, sessionId),
        enqueueProcessResults: (providerJobId) =>
          enqueueProcessProviderResults(helpers.addJob, providerJobId),
        enqueueSessionCover: (args) => enqueueSessionCoverKick(helpers.addJob, args),
        info: (message, fields) => helpers.logger.info(message, fields),
      },
      payload as PollMusicGenerationPayload,
    );
  };
}
