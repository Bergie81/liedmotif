// Session reads/writes for the worker generation controller.
//
// Lifecycle writes go through the merged two-state transition map
// (`canTransition`) and a guarded conditional UPDATE, so the worker can never
// race a user Stop/Resume into an illegal move. `generationStatus` is a
// controller FIELD (never a lifecycle state) and is written separately.

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  canTransition,
  type ProviderNormalizedStatus,
  type SessionEndReason,
  type SessionGenerationStatus,
} from '@liedmotif/shared';
import type { Database } from '../client';
import { withTransaction, type DbOrTx, type Transaction } from '../transactions';
import { inFlightProviderJobCondition } from './limits-repo';
import { queueItemRequestEdge } from './queue-request-edge';
import {
  activitySessions,
  activitySessionQueueItems,
  generationRequests,
  providerJobs,
  type providerSubmitState,
  SPEND_SUBMIT_STATES,
  tracks,
  type StyleSnapshot,
} from '../schema';

/** The session fields the sweep needs for auto-stop + buffer decisions. */
export interface SweepSession {
  sessionId: string;
  ownerUserId: string;
  startedAt: Date;
  lastResumedAt: Date | null;
  lastPlaybackReportAt: Date | null;
  idleAutoStopAfterMinutes: number;
  targetDurationMinutes: number | null;
  sessionMode: 'keep_going' | 'repeat';
  generationStatus: SessionGenerationStatus;
}

/** Bound on one sweep pass, matching every other sweep's capped shape. Today's
 *  active set is tiny (one active session per owner); the cap is future-proofing. */
export const ACTIVE_SESSION_SWEEP_LIMIT = 100;

/**
 * ACTIVE sessions for one sweep pass (Stopped are excluded — they are never
 * swept). Returns the fields the idle/bounded classifier and the buffer
 * controller both read. Stalest playback first, so under the cap the sessions
 * closest to an auto-stop are never starved by fresher ones.
 */
export async function listActiveSessionsForSweep(
  db: Database,
  options: { limit?: number } = {},
): Promise<SweepSession[]> {
  return db
    .select({
      sessionId: activitySessions.id,
      ownerUserId: activitySessions.ownerUserId,
      startedAt: activitySessions.startedAt,
      lastResumedAt: activitySessions.lastResumedAt,
      lastPlaybackReportAt: activitySessions.lastPlaybackReportAt,
      idleAutoStopAfterMinutes: activitySessions.idleAutoStopAfterMinutes,
      targetDurationMinutes: activitySessions.targetDurationMinutes,
      sessionMode: activitySessions.sessionMode,
      generationStatus: activitySessions.generationStatus,
    })
    .from(activitySessions)
    .where(eq(activitySessions.status, 'active'))
    .orderBy(
      sql`coalesce(${activitySessions.lastPlaybackReportAt}, ${activitySessions.lastResumedAt}, ${activitySessions.startedAt}) asc`,
    )
    .limit(options.limit ?? ACTIVE_SESSION_SWEEP_LIMIT);
}

/**
 * Move an active session to `stopped` with the given end reason (worker idle /
 * bounded auto-stop). Guarded by the transition map AND a conditional UPDATE on
 * `status = 'active'`, so an already-stopped session is a no-op (`stopped:false`)
 * and a concurrent user Stop/Resume is never clobbered.
 */
export async function stopSessionFromWorker(
  db: Database,
  args: {
    sessionId: string;
    endReason: Extract<SessionEndReason, 'idle_timeout' | 'completed_duration'>;
    now?: Date;
  },
): Promise<{ stopped: boolean }> {
  const now = args.now ?? new Date();
  const [current] = await db
    .select({ status: activitySessions.status })
    .from(activitySessions)
    .where(eq(activitySessions.id, args.sessionId))
    .limit(1);
  if (!current || !canTransition('activitySessionStatus', current.status, 'stopped')) {
    return { stopped: false };
  }

  const updated = await db
    .update(activitySessions)
    // An armed switch-now dies with the session, as on a user Stop.
    .set({ status: 'stopped', endReason: args.endReason, stoppedAt: now, vibeSwitchRevision: null })
    .where(and(eq(activitySessions.id, args.sessionId), eq(activitySessions.status, 'active')))
    .returning({ id: activitySessions.id });
  return { stopped: updated.length > 0 };
}

/** The session fields the buffer controller reads each tick. */
export interface BufferSession {
  targetDurationMinutes: number | null;
  sessionId: string;
  ownerUserId: string;
  status: 'active' | 'stopped';
  sessionMode: 'keep_going' | 'repeat';
  generationStatus: SessionGenerationStatus;
  snapshot: StyleSnapshot | null;
  /** The session's accumulated prompt history — frozen onto every fresh submit. */
  userPrompt: string | null;
  /** The snapshot's monotonic revision — stamped onto every submit (blend identity). */
  styleRevision: number;
  /** Armed switch-now target revision (null = play buffered tracks out). While
   *  set, the buffer tick counts only supply at/above it. */
  vibeSwitchRevision: number | null;
  // Listener-liveness inputs: paid top-ups are gated on someone actually
  // listening (a recent playback report) or a fresh Start/Resume (cold start).
  startedAt: Date;
  lastResumedAt: Date | null;
  lastPlaybackReportAt: Date | null;
}

/** The one selection both buffer-session readers share, so they cannot drift. */
const BUFFER_SESSION_SELECTION = {
  targetDurationMinutes: activitySessions.targetDurationMinutes,
  sessionId: activitySessions.id,
  ownerUserId: activitySessions.ownerUserId,
  status: activitySessions.status,
  sessionMode: activitySessions.sessionMode,
  generationStatus: activitySessions.generationStatus,
  snapshot: activitySessions.sessionStyleSnapshot,
  userPrompt: activitySessions.userPrompt,
  styleRevision: activitySessions.styleRevision,
  vibeSwitchRevision: activitySessions.vibeSwitchRevision,
  startedAt: activitySessions.startedAt,
  lastResumedAt: activitySessions.lastResumedAt,
  lastPlaybackReportAt: activitySessions.lastPlaybackReportAt,
} as const;

/** Load the buffer-relevant session fields (incl. the frozen Style Snapshot). */
export async function getSessionForBuffer(
  db: Database,
  sessionId: string,
): Promise<BufferSession | null> {
  const [row] = await db
    .select(BUFFER_SESSION_SELECTION)
    .from(activitySessions)
    .where(eq(activitySessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/**
 * Re-read the buffer session inside the caller's transaction under a row lock.
 * The buffer tick's pre-lock session read can be stale by the time it enters
 * the per-owner generation lock (while a tick waits there, a session hop can
 * stop THIS session, a Change Vibe can replace its Style Snapshot, or the user
 * can switch it to Repeat), and every one of those fields feeds the paid
 * decision — so the tick re-reads the WHOLE row here and decides/compiles from
 * this one. `FOR NO KEY UPDATE` blocks behind a concurrent session UPDATE
 * (Stop/Resume, restyle, mode switch) and re-evaluates on the post-commit row
 * (a plain SELECT would read the pre-commit version), while staying compatible
 * with the `KEY SHARE` locks of rows FK-referencing the session.
 */
export async function lockSessionForBuffer(
  tx: Transaction,
  sessionId: string,
): Promise<BufferSession | null> {
  const [row] = await tx
    .select(BUFFER_SESSION_SELECTION)
    .from(activitySessions)
    .where(eq(activitySessions.id, sessionId))
    .limit(1)
    .for('no key update');
  return row ?? null;
}

/**
 * Write the session's `generationStatus` (+ a safe user-facing message). This is
 * the controller-only field (`SESSION_FIELD_WRITERS.generationStatus`) — never a
 * lifecycle move, so the session stays whatever it was (always `active` here).
 */
export async function setGenerationStatus(
  db: Database,
  args: {
    sessionId: string;
    status: SessionGenerationStatus;
    statusMessageSafe?: string | null;
    /** Which bound a Member's cost-limit names; omitted clears it. */
    scope?: 'member' | 'pool' | null;
  },
): Promise<void> {
  await db
    .update(activitySessions)
    .set({
      generationStatus: args.status,
      // Always written (defaulting to null): a stale scope must never outlive
      // the cost-limited status that set it.
      generationStatusScope: args.scope ?? null,
      ...(args.statusMessageSafe !== undefined
        ? { statusMessageSafe: args.statusMessageSafe }
        : {}),
    })
    .where(eq(activitySessions.id, args.sessionId));
}

/** Optional "request is at/above this style revision" filter, spread into a
 *  `where`: an armed switch-now scopes a count to new-vibe supply; `undefined`
 *  contributes nothing. */
function styleRevisionAtLeast(revision: number | undefined): SQL[] {
  return revision === undefined ? [] : [gte(generationRequests.styleRevision, revision)];
}

/**
 * Ready-ahead queue items (planned/generating/queued) — the Buffer fill measure.
 * With `atOrAboveStyleRevision` (an armed switch-now Change Vibe), only items
 * whose request carries that revision or newer count as supply; older-revision
 * material — including a null/legacy revision — is what the switch will set
 * aside, so it must not satisfy the watermark.
 */
export async function countReadyAheadTracks(
  db: DbOrTx,
  sessionId: string,
  opts: { atOrAboveStyleRevision?: number } = {},
): Promise<number> {
  const [row] = await readyAheadTracksQuery(db, sessionId, opts.atOrAboveStyleRevision);
  return row?.value ?? 0;
}

function readyAheadTracksQuery(db: DbOrTx, sessionId: string, atOrAboveStyleRevision?: number) {
  return db
    .select({ value: count() })
    .from(activitySessionQueueItems)
    .leftJoin(tracks, eq(activitySessionQueueItems.trackId, tracks.id))
    .leftJoin(generationRequests, queueItemRequestEdge())
    .where(
      and(
        eq(activitySessionQueueItems.activitySessionId, sessionId),
        inArray(activitySessionQueueItems.state, ['planned', 'generating', 'queued']),
        ...styleRevisionAtLeast(atOrAboveStyleRevision),
      ),
    );
}

/**
 * In-flight provider JOBS for a session — submitted/processing work (and recent
 * uncertain submits) that will (or may already) yield tracks but hasn't shown up as
 * a ready track yet. The buffer controller counts these so overlapping sweeps and
 * post-submit retries can't double-submit a paid job before its tracks exist.
 *
 * What holds a slot (LIVE at any age; PHANTOM only while younger than
 * `phantomSubmitCutoff`) is the shared `inFlightProviderJobCondition` — one
 * definition with the owner-wide concurrency count, so the two can never drift.
 */
export async function countInFlightSessionJobs(
  db: DbOrTx,
  args: {
    sessionId: string;
    phantomSubmitCutoff: Date;
    /** Armed switch-now: only jobs at/above this request revision count as
     *  incoming supply (older in-flight work will be set aside at cutover). */
    atOrAboveStyleRevision?: number;
  },
): Promise<number> {
  const [row] = await inFlightSessionJobsQuery(db, args);
  return row?.value ?? 0;
}

function inFlightSessionJobsQuery(
  db: DbOrTx,
  args: { sessionId: string; phantomSubmitCutoff: Date; atOrAboveStyleRevision?: number },
) {
  return db
    .select({ value: count() })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(
      and(
        eq(generationRequests.activitySessionId, args.sessionId),
        inFlightProviderJobCondition(args.phantomSubmitCutoff),
        ...styleRevisionAtLeast(args.atOrAboveStyleRevision),
      ),
    );
}

/**
 * Tracks the session's provider jobs still owe — the Buffer's incoming supply,
 * counted in Tracks so it never overlaps the Queue: a job's Tracks enter the
 * Queue while it streams, still in flight. Per job it is the request's
 * `requestedTrackCount` minus every Track row created from it (any status: a
 * Disliked or deleted Track is replaced by its reroll, not owed again), floored
 * at 0. A job owes while it holds an in-flight slot, and after `ready` until its
 * request is `materialized` — `ready` is written before the Tracks are, and that
 * gap must not read as no supply. Failed and timed-out jobs owe nothing.
 */
function incomingSessionTracksQuery(
  db: DbOrTx,
  args: { sessionId: string; phantomSubmitCutoff: Date; atOrAboveStyleRevision?: number },
) {
  const created = sql`(select count(*) from ${tracks} where ${tracks.providerJobId} = ${providerJobs.id})`;
  return db
    .select({
      value: sql<number>`coalesce(sum(greatest(${generationRequests.requestedTrackCount} - ${created}, 0)), 0)`,
    })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(
      and(
        eq(generationRequests.activitySessionId, args.sessionId),
        or(
          inFlightProviderJobCondition(args.phantomSubmitCutoff),
          and(
            eq(providerJobs.normalizedStatus, 'ready'),
            ne(generationRequests.status, 'materialized'),
          ),
        ),
        ...styleRevisionAtLeast(args.atOrAboveStyleRevision),
      ),
    );
}

/**
 * ALL generation requests the session has EVER created, in any state. This is the
 * buffer controller's per-track compile index: it must be MONOTONIC, and ready-track
 * counts are not (a dislike flips tracks to `rejected`, eviction/deletion remove
 * them), so indexing off them would re-derive an earlier track's hidden seed and
 * resubmit a byte-identical request on a fresh reroll.
 */
export async function countSessionGenerationRequests(
  db: DbOrTx,
  sessionId: string,
  opts: {
    /** Count requests for the current or a later Style Snapshot revision. The
     *  monotonic compile index must use the unscoped count. */
    atOrAboveStyleRevision?: number;
    /** Leave out requests the provider refused unbilled — they bought nothing,
     *  so they never stand for a batch the Session already received. The
     *  compile index must keep them: it is monotonic over every request. */
    excludeUnbilledRefusals?: boolean;
  } = {},
): Promise<number> {
  const [row] = await sessionGenerationRequestsQuery(db, sessionId, opts);
  return row?.value ?? 0;
}

/** Optional "request was not refused unbilled" filter, spread into a `where`
 *  like `styleRevisionAtLeast`. A request carries the one provider job recorded
 *  with it (`insertSubmittingGenerationJob`), so a `submit_rejected` job means
 *  the whole request was refused before any charge. */
export function notUnbilledRefusal(db: DbOrTx, exclude: boolean | undefined): SQL[] {
  if (!exclude) return [];
  const rejectedJob = db
    .select({ one: sql`1` })
    .from(providerJobs)
    .where(
      and(
        eq(providerJobs.generationRequestId, generationRequests.id),
        eq(providerJobs.submitState, 'submit_rejected'),
      ),
    );
  return [notExists(rejectedJob)];
}

function sessionGenerationRequestsQuery(
  db: DbOrTx,
  sessionId: string,
  opts: { atOrAboveStyleRevision?: number; excludeUnbilledRefusals?: boolean } = {},
) {
  return db
    .select({ value: count() })
    .from(generationRequests)
    .where(
      and(
        eq(generationRequests.activitySessionId, sessionId),
        ...styleRevisionAtLeast(opts.atOrAboveStyleRevision),
        ...notUnbilledRefusal(db, opts.excludeUnbilledRefusals),
      ),
    );
}

/** The session's own already-generated `ready` tracks (Repeat viability + loop). */
export async function countSessionOwnReadyTracks(db: DbOrTx, sessionId: string): Promise<number> {
  const [row] = await sessionOwnReadyTracksQuery(db, sessionId);
  return row?.value ?? 0;
}

function sessionOwnReadyTracksQuery(db: DbOrTx, sessionId: string) {
  return db
    .select({ value: count() })
    .from(tracks)
    .innerJoin(generationRequests, eq(tracks.generationRequestId, generationRequests.id))
    .where(and(eq(generationRequests.activitySessionId, sessionId), eq(tracks.status, 'ready')));
}

/** The per-session buffer counts, named for what the tick decides with them. */
export interface BufferSessionCounts {
  readyAhead: number;
  ownReady: number;
  /** In-flight provider jobs — the stuck and restart checks, never the Buffer measure. */
  inFlightJobs: number;
  /** Tracks the session's provider jobs still owe — the Buffer's incoming supply. */
  incomingTracks: number;
  /** Every request, refused ones included — the monotonic compile index. */
  totalRequests: number;
  /** Requests that bought (or may have bought) a batch: all but unbilled refusals. */
  unrefusedRequests: number;
  /** `unrefusedRequests` for the current Style Snapshot revision. */
  currentRevisionUnrefusedRequests: number;
}

/**
 * The buffer tick's per-session counts in ONE statement — the tick runs them
 * inside the owner advisory lock, so the round trips of scalar counts collapse
 * to one (same transaction, same snapshot). A column with a standalone count
 * function embeds exactly that function's query, so the two can never drift.
 * `supplyAtOrAboveStyleRevision` scopes the in-flight and supply counts (an
 * armed switch-now Change Vibe); `requestsAtOrAboveStyleRevision` scopes only
 * `currentRevisionUnrefusedRequests` (omitted = the unscoped count, the
 * revision-1 shape).
 */
export async function getBufferSessionCounts(
  db: DbOrTx,
  args: {
    sessionId: string;
    phantomSubmitCutoff: Date;
    supplyAtOrAboveStyleRevision?: number;
    requestsAtOrAboveStyleRevision?: number;
  },
): Promise<BufferSessionCounts> {
  const scalar = (query: { getSQL(): SQL }): SQL<number> => sql<number>`(${query})::int`;
  const totalRequests = scalar(sessionGenerationRequestsQuery(db, args.sessionId));
  const unrefusedRequests = scalar(
    sessionGenerationRequestsQuery(db, args.sessionId, { excludeUnbilledRefusals: true }),
  );
  const [row] = await db
    .select({
      readyAhead: scalar(
        readyAheadTracksQuery(db, args.sessionId, args.supplyAtOrAboveStyleRevision),
      ),
      ownReady: scalar(sessionOwnReadyTracksQuery(db, args.sessionId)),
      inFlightJobs: scalar(
        inFlightSessionJobsQuery(db, {
          sessionId: args.sessionId,
          phantomSubmitCutoff: args.phantomSubmitCutoff,
          atOrAboveStyleRevision: args.supplyAtOrAboveStyleRevision,
        }),
      ),
      incomingTracks: scalar(
        incomingSessionTracksQuery(db, {
          sessionId: args.sessionId,
          phantomSubmitCutoff: args.phantomSubmitCutoff,
          atOrAboveStyleRevision: args.supplyAtOrAboveStyleRevision,
        }),
      ),
      totalRequests,
      unrefusedRequests,
      currentRevisionUnrefusedRequests:
        args.requestsAtOrAboveStyleRevision === undefined
          ? unrefusedRequests
          : scalar(
              sessionGenerationRequestsQuery(db, args.sessionId, {
                atOrAboveStyleRevision: args.requestsAtOrAboveStyleRevision,
                excludeUnbilledRefusals: true,
              }),
            ),
    })
    .from(sql`(select 1) as one_row`);
  // The one-row FROM clause guarantees exactly one result row.
  return row!;
}

/**
 * Append fresh titles to the Session's live track-title pool and return the pool
 * as it now stands (null when the Session or its snapshot is gone). Append-only
 * under a row lock, so a Track ordinal names the same title for the Session's
 * whole life and two refills racing each other both land instead of one
 * overwriting the other. This is the one place a refill's titles are checked
 * against the pool: titles it already holds (case-insensitively) are skipped,
 * and the pool never exceeds `maxPool`.
 */
export async function appendSessionTrackTitles(
  db: Database,
  args: { sessionId: string; titles: string[]; maxPool: number },
): Promise<string[] | null> {
  return withTransaction(db, async (tx) => {
    const [row] = await tx
      .select({ snapshot: activitySessions.sessionStyleSnapshot })
      .from(activitySessions)
      .where(eq(activitySessions.id, args.sessionId))
      .for('update');
    if (!row?.snapshot) return null;
    const current = (row.snapshot.trackTitles ?? []).filter(
      (title): title is string => typeof title === 'string',
    );
    const seen = new Set(current.map((title) => title.trim().toLowerCase()));
    const pool = [...current];
    for (const title of args.titles) {
      if (pool.length >= args.maxPool) break;
      const key = title.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pool.push(title);
    }
    if (pool.length > current.length) {
      await tx
        .update(activitySessions)
        .set({ sessionStyleSnapshot: { ...row.snapshot, trackTitles: pool } })
        .where(eq(activitySessions.id, args.sessionId));
    }
    return pool;
  });
}

/**
 * The lyric briefs (`styleSnapshot.lyricContext`) frozen on the session's most
 * recent generation requests, newest first — the variety memory a per-generation
 * track-lyric-brief call must differ from. Session-scoped but revision-agnostic:
 * cross-revision repetition is still repetition.
 * Empties are filtered in SQL so the cap counts USABLE briefs — recent requests
 * with a blank brief never starve the caller of older non-empty ones. A plain
 * ordered select: it runs outside the owner generation lock. The id tie-breaker
 * makes "newest" deterministic under equal created_at (arbitrary but stable).
 * `excludeRequestId` keeps the caller's OWN request out of the memory: the brief
 * injection reads after its intent row commits, and that row's frozen snapshot
 * still carries the static base notes — not a brief to differ from.
 */
export async function getRecentLyricBriefs(
  db: DbOrTx,
  args: { sessionId: string; limit: number; excludeRequestId?: string },
): Promise<string[]> {
  const brief = sql<string>`${generationRequests.styleSnapshot} ->> 'lyricContext'`;
  const rows = await db
    .select({ brief })
    .from(generationRequests)
    .where(
      and(
        eq(generationRequests.activitySessionId, args.sessionId),
        sql`nullif(${brief}, '') is not null`,
        ...(args.excludeRequestId ? [ne(generationRequests.id, args.excludeRequestId)] : []),
      ),
    )
    .orderBy(desc(generationRequests.createdAt), desc(generationRequests.id))
    .limit(args.limit);
  return rows.map((row) => row.brief);
}

/** The session's own `ready` track ids, oldest-first — the Session Repeat loop set. */
export async function listSessionLoopCandidates(
  db: Database,
  sessionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: tracks.id })
    .from(tracks)
    .innerJoin(generationRequests, eq(tracks.generationRequestId, generationRequests.id))
    .where(and(eq(generationRequests.activitySessionId, sessionId), eq(tracks.status, 'ready')))
    .orderBy(tracks.createdAt);
  return rows.map((row) => row.id);
}

/**
 * The session's EARLIEST-created fully-ready music task id for `providerKey`, or
 * null while none exists yet: which music task feeds a music-task-driven Session
 * Cover (the provider allows one cover per music task). An older task can turn
 * ready later and take over, so the answer can change; cover admission pins the
 * task it chose and a safe retry reuses that pin. Ordered by creation with an id
 * tie-breaker for determinism under equal timestamps.
 */
export async function getEarliestReadySessionMusicTaskId(
  db: DbOrTx,
  args: { ownerUserId: string; activitySessionId: string; providerKey: string },
): Promise<string | null> {
  const [row] = await db
    .select({ providerTaskId: providerJobs.providerTaskId })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(
      and(
        eq(generationRequests.activitySessionId, args.activitySessionId),
        eq(generationRequests.ownerUserId, args.ownerUserId),
        eq(providerJobs.providerKey, args.providerKey),
        eq(providerJobs.normalizedStatus, 'ready'),
        isNotNull(providerJobs.providerTaskId),
      ),
    )
    .orderBy(asc(providerJobs.createdAt), asc(providerJobs.id))
    .limit(1);
  return row?.providerTaskId ?? null;
}

/**
 * The most recent provider-job state for a session, or null if it never generated.
 * `stylePrompt` is the SESSION-frozen style the job's request submitted (no
 * per-track variation) — the buffer controller compares it against the session's
 * CURRENT session style to decide whether a `blocked_by_policy` block still
 * applies (a Change Vibe lifts it). `submitState` tells a refused submit
 * waiting out a recoverable status from a submitted job that reached it.
 * `spentOnly` skips the jobs that bought nothing (an unbilled refusal, a job
 * that never reached the provider), so it answers with the latest batch that
 * was paid or may have been paid.
 */
export async function getLatestProviderJobState(
  db: DbOrTx,
  sessionId: string,
  { spentOnly = false }: { spentOnly?: boolean } = {},
): Promise<{
  normalizedStatus: ProviderNormalizedStatus;
  submitState: (typeof providerSubmitState.enumValues)[number];
  createdAt: Date;
  updatedAt: Date;
  stylePrompt: string | null;
} | null> {
  const [row] = await db
    .select({
      normalizedStatus: providerJobs.normalizedStatus,
      submitState: providerJobs.submitState,
      createdAt: providerJobs.createdAt,
      updatedAt: providerJobs.updatedAt,
      stylePrompt: generationRequests.stylePrompt,
    })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(
      and(
        eq(generationRequests.activitySessionId, sessionId),
        spentOnly ? inArray(providerJobs.submitState, [...SPEND_SUBMIT_STATES]) : undefined,
      ),
    )
    // The id tie-breaker makes "latest" deterministic when fast inserts share a
    // created_at timestamp (arbitrary but stable, so the signal can't flip-flop).
    .orderBy(desc(providerJobs.createdAt), desc(providerJobs.id))
    .limit(1);
  return row ?? null;
}
