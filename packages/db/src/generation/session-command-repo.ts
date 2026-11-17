// Session lifecycle command writes for the API routes. These routes OWN the
// lifecycle fields the rest of the system reads but never sets:
//
//   - createSession / moreLikeThis / resumeSession / playSessionTrack write
//     `endReason='superseded'` on the active session they supersede (the
//     at-most-one-active invariant);
//   - stopSession writes `endReason='user_stopped'`;
//   - resumeSession (and playSessionTrack on a Stopped session) re-activates it in
//     place — same identity, stored Style Snapshot + queue — sets `lastResumedAt`,
//     and resets `generationStatus` to `ok` (the one route-side write of that
//     controller field);
//   - setSessionMode is the mode switch (user intent; the worker only consumes
//     the mode) — createSession seeds the starting mode from the owner's Buffer
//     default, and this is the only writer afterwards.
//
// Lifecycle moves go through the merged two-state transition guard
// (`canTransition`/`assert*`) and owner-scoped conditional UPDATEs, so a route can
// never race the worker idle/auto-stop sweep into an illegal state. Per-track
// generation is NOT triggered here — the worker buffer controller tops up every
// active session — so these stay pure session writes.
//
// Every writer that makes a session `active` (create / resume / play-track) runs
// under `withOwnerGenerationLock` — see `supersedeActiveSession` for why — which
// is also the lock the worker's buffer tick takes before it row-locks a session,
// so the acquisition order (advisory lock, then session rows) is the same on both
// sides.

import { and, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  assertChangeVibePreservesSession,
  assertResumeReactivates,
  canTransition,
  extendPromptHistory,
  resolveActivePlaybackClient,
  type CoverStyle,
  type PersistedPlaybackEventType,
  type PlaybackReportType,
  type SessionGenerationStatus,
  sanitizeCoverStyleHint,
  sanitizeCoverConcept,
} from '@liedmotif/shared';
import type { Database } from '../client';
import { viewerCanReadTrack } from '../playlists/lounge-audible';
import { withTransaction, type Transaction } from '../transactions';
import { sessionDurationColumns } from './session-duration-repo';
import { withOwnerGenerationLock } from './limits-repo';
import { sessionNotPendingDelete } from './session-list-repo';
import { resolvePlayableSessionTrackSlot } from './session-tracks-repo';
import {
  activitySessions,
  activitySessionQueueItems,
  generationRequests,
  playbackEvents,
  tracks,
  type StructuredControls,
  type StyleSnapshot,
} from '../schema';

// --- The session record the routes serialize to `sessionSummarySchema` ----------

export interface SessionRecord {
  id: string;
  ownerUserId: string;
  title: string | null;
  coverConcept: string | null;
  coverStyleFallbackReason: string | null;
  status: 'active' | 'stopped';
  sessionMode: 'keep_going' | 'repeat';
  generationStatus: SessionGenerationStatus;
  coverImageId: string | null;
  /** Generated-cover art-direction lane (`auto` = the cover pipeline picks). */
  coverStyle: CoverStyle;
  /** Private Custom definition; null for every non-Custom state. */
  coverStyleHint: string | null;
  /** Deterministically normalized Custom definition. */
  coverStyleHintNormalized: string | null;
  /** Standard covers (music provider's cover endpoint) instead of styled ones. */
  useStandardCover: boolean;
  /** The session's accumulated free-text intent (`extendPromptHistory`); null
   *  while it has only ever been steered by structured controls. */
  userPrompt: string | null;
  /** The stored structured controls, when the session came from the controls path. */
  structuredControls: StructuredControls | null;
  /** Start-without-profile: the owner's own details (listener profile, own
   *  About, owner Person and photos) stay out of this session's LLM prompts and
   *  generated cover; the other People its request names stay in. */
  skipProfile: boolean;
  /** The request puts the listener in its own scene: the generated cover
   *  treats the owner Person as named. */
  includesListener: boolean;
  statusMessageSafe: string | null;
  /** Which bound a Member's cost-limit names (member/pool); null otherwise. */
  generationStatusScope: 'member' | 'pool' | null;
  endReason: 'user_stopped' | 'completed_duration' | 'superseded' | 'idle_timeout' | null;
  sessionStyleSnapshot: StyleSnapshot | null;
  /** Monotonic snapshot revision; Change Vibe bumps it atomically with the snapshot. */
  styleRevision: number;
  /** Armed switch-now target revision (cut over when a track at/above it is
   *  playable); null = play buffered tracks out. */
  vibeSwitchRevision: number | null;
  targetDurationMinutes: number | null;
  generatedDurationSeconds?: number;
  unknownDurationTrackCount?: number;
  currentTrackId: string | null;
  currentQueueItemId: string | null;
  lastResumedAt: Date | null;
  lastPlaybackReportAt: Date | null;
  stoppedAt: Date | null;
  /** Set while a Delete Session waits on in-flight work; the session is gone to the user. */
  deleteRequestedAt: Date | null;
  startedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** The reusable select/returning shape for a full session record. */
const sessionColumns = {
  id: activitySessions.id,
  ownerUserId: activitySessions.ownerUserId,
  title: activitySessions.title,
  coverConcept: activitySessions.coverConcept,
  coverStyleFallbackReason: activitySessions.coverStyleFallbackReason,
  status: activitySessions.status,
  sessionMode: activitySessions.sessionMode,
  generationStatus: activitySessions.generationStatus,
  coverImageId: activitySessions.coverImageId,
  coverStyle: activitySessions.coverStyle,
  coverStyleHint: activitySessions.coverStyleHint,
  coverStyleHintNormalized: activitySessions.coverStyleHintNormalized,
  useStandardCover: activitySessions.useStandardCover,
  userPrompt: activitySessions.userPrompt,
  structuredControls: activitySessions.structuredControls,
  skipProfile: activitySessions.skipProfile,
  includesListener: activitySessions.includesListener,
  statusMessageSafe: activitySessions.statusMessageSafe,
  generationStatusScope: activitySessions.generationStatusScope,
  endReason: activitySessions.endReason,
  sessionStyleSnapshot: activitySessions.sessionStyleSnapshot,
  styleRevision: activitySessions.styleRevision,
  vibeSwitchRevision: activitySessions.vibeSwitchRevision,
  targetDurationMinutes: activitySessions.targetDurationMinutes,
  ...sessionDurationColumns(sql`${activitySessions.id}`, sql`${activitySessions.ownerUserId}`),
  currentTrackId: activitySessions.currentTrackId,
  currentQueueItemId: activitySessions.currentQueueItemId,
  lastResumedAt: activitySessions.lastResumedAt,
  lastPlaybackReportAt: activitySessions.lastPlaybackReportAt,
  stoppedAt: activitySessions.stoppedAt,
  deleteRequestedAt: activitySessions.deleteRequestedAt,
  startedAt: activitySessions.startedAt,
  createdAt: activitySessions.createdAt,
  updatedAt: activitySessions.updatedAt,
} as const;

/** Load a session by id, scoped to its owner (null when absent or not owned). */
export async function getSessionById(
  db: Database,
  args: { ownerUserId: string; sessionId: string },
): Promise<SessionRecord | null> {
  const [row] = await db
    .select(sessionColumns)
    .from(activitySessions)
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function lockSessionForCoverPlanning(
  db: Database,
  args: { ownerUserId: string; sessionId: string },
): Promise<SessionRecord | null> {
  const [row] = await db
    .select(sessionColumns)
    .from(activitySessions)
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    )
    .for('update')
    .limit(1);
  return row ?? null;
}

/**
 * The owner's at-most-one currently-active session, or null. Owner-scoped — used by
 * the diagnostics route to bootstrap "what's playing" (the home view) and by anything
 * that needs the single live session without knowing its id.
 */
export async function getActiveSession(
  db: Database,
  args: { ownerUserId: string },
): Promise<SessionRecord | null> {
  const [row] = await db
    .select(sessionColumns)
    .from(activitySessions)
    .where(
      and(
        eq(activitySessions.ownerUserId, args.ownerUserId),
        eq(activitySessions.status, 'active'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Supersede the owner's currently-active session (if any): move it to `stopped`
 * with `endReason='superseded'`. Returns the superseded id, or null when none was
 * active. Must run inside the create/resume transaction so the partial unique index
 * (one active session per owner) is never violated — and that transaction must
 * hold the owner generation lock: a conditional UPDATE that matches nothing takes
 * no lock, so two simultaneous starts (double-tap, two tabs) would both find
 * nothing to supersede and both insert an `active` row, and the index violation
 * reaches the caller as an unhandled error.
 */
async function supersedeActiveSession(
  db: Database,
  ownerUserId: string,
  now: Date,
): Promise<string | null> {
  const superseded = await db
    .update(activitySessions)
    // An armed switch-now dies with the session, as on a user Stop.
    .set({ status: 'stopped', endReason: 'superseded', stoppedAt: now, vibeSwitchRevision: null })
    .where(
      and(eq(activitySessions.ownerUserId, ownerUserId), eq(activitySessions.status, 'active')),
    )
    .returning({ id: activitySessions.id });
  return superseded[0]?.id ?? null;
}

/**
 * A Session duration target is met by buying music, so setting one puts the
 * Session on Keep Going; Repeat would stop at the first batch and never reach
 * it. Clearing the target leaves the mode alone unless the same write names one.
 */
function durationTargetMode(targetDurationMinutes: number | null | undefined) {
  return targetDurationMinutes != null ? { sessionMode: 'keep_going' as const } : {};
}

// --- createSession (Start Session / More Like This) -----------------------------

export interface CreateSessionInput {
  ownerUserId: string;
  /** The single frozen Style Snapshot (template or text-LLM derived) to persist. */
  snapshot: StyleSnapshot;
  /**
   * The mode the session starts in — the owner's Buffer default
   * (`defaultSessionMode`), decided at the route. Required so no creation path
   * can silently fall back to the column default and bypass that default. A
   * `targetDurationMinutes` overrides it with Keep Going.
   */
  sessionMode: 'keep_going' | 'repeat';
  title?: string | null;
  coverConcept?: string | null;
  userPrompt?: string | null;
  structuredControls?: StructuredControls | null;
  /** Start this session without the owner's own details (profile, About,
   *  owner Person); the other People its request names stay in. */
  skipProfile?: boolean;
  /** The text LLM read the request as putting the listener in its scene;
   *  omitted (More Like This, Surprise Me) is no. */
  includesListener?: boolean;
  targetDurationMinutes?: number | null;
  /** The immediate cover (the built-in placeholder); the async generated cover
   *  replaces it when ready. */
  coverImageId?: string | null;
  /** Generated-cover art-direction lane; omitted → the column default `auto`. */
  coverStyle?: CoverStyle;
  /** Private Custom definition normalized at this write boundary. */
  coverStyleHint?: string | null;
  /** Standard covers (music provider's cover endpoint) instead of styled ones. */
  useStandardCover?: boolean;
  now?: Date;
}

export interface CreateSessionResult {
  session: SessionRecord;
  /** The previously-active session this one superseded (stopped), if any. */
  supersededSessionId: string | null;
}

/**
 * Create a new active session from the derived Style Snapshot, superseding the
 * owner's prior active session in the SAME transaction (so the one-active-per-owner
 * index is never violated). The headroom gate runs BEFORE this in the route
 * — below the threshold no row is created at all.
 */
export async function createSession(
  db: Database,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  return withOwnerGenerationLock(db, input.ownerUserId, (tx) => createSessionInTx(tx, input));
}

/**
 * `createSession`'s writes, for a caller that must commit something else with
 * them. `tx` MUST already hold the owner generation lock.
 */
export async function createSessionInTx(
  tx: Transaction,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const now = input.now ?? new Date();
  const requestedCustom = input.coverStyle === 'custom';
  const customDefinition = requestedCustom
    ? sanitizeCoverStyleHint(input.coverStyleHint ?? '')
    : '';
  const persistedCoverStyle = requestedCustom
    ? customDefinition
      ? 'custom'
      : 'auto'
    : input.coverStyle;
  const supersededSessionId = await supersedeActiveSession(tx, input.ownerUserId, now);
  const [session] = await tx
    .insert(activitySessions)
    .values({
      ownerUserId: input.ownerUserId,
      sessionStyleSnapshot: input.snapshot,
      sessionMode: input.sessionMode,
      ...durationTargetMode(input.targetDurationMinutes),
      status: 'active',
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.coverConcept !== undefined
        ? {
            coverConcept: input.coverConcept
              ? sanitizeCoverConcept(input.coverConcept) || null
              : null,
          }
        : {}),
      ...(input.userPrompt !== undefined ? { userPrompt: input.userPrompt } : {}),
      ...(input.structuredControls !== undefined
        ? { structuredControls: input.structuredControls }
        : {}),
      ...(input.skipProfile !== undefined ? { skipProfile: input.skipProfile } : {}),
      ...(input.includesListener !== undefined ? { includesListener: input.includesListener } : {}),
      ...(input.useStandardCover !== undefined ? { useStandardCover: input.useStandardCover } : {}),
      ...(input.targetDurationMinutes != null
        ? { targetDurationMinutes: input.targetDurationMinutes }
        : {}),
      ...(input.coverImageId != null ? { coverImageId: input.coverImageId } : {}),
      ...(persistedCoverStyle !== undefined ? { coverStyle: persistedCoverStyle } : {}),
      ...(persistedCoverStyle === 'custom'
        ? { coverStyleHint: customDefinition, coverStyleHintNormalized: customDefinition }
        : {}),
      ...(requestedCustom && !customDefinition
        ? { coverStyleFallbackReason: 'invalid_custom_fell_back_to_auto' }
        : {}),
    })
    .returning(sessionColumns);
  return { session: session!, supersededSessionId };
}

// --- stopSession ----------------------------------------------------------------

/**
 * Stop the owner's session with `endReason='user_stopped'`. Owner-scoped and
 * transition-guarded: only an `active` row is moved (so an already-stopped session
 * is an idempotent no-op that KEEPS its prior endReason). Returns null when the
 * session is absent or not owned.
 */
export async function stopSession(
  db: Database,
  args: { ownerUserId: string; sessionId: string; now?: Date },
): Promise<{ id: string; status: 'stopped' } | null> {
  const now = args.now ?? new Date();
  const updated = await db
    .update(activitySessions)
    // An armed switch-now dies with the session — nothing is left to cut over to.
    .set({ status: 'stopped', endReason: 'user_stopped', stoppedAt: now, vibeSwitchRevision: null })
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
        eq(activitySessions.status, 'active'),
      ),
    )
    .returning({ id: activitySessions.id });
  if (updated[0]) return { id: updated[0].id, status: 'stopped' };

  // No active row updated — disambiguate already-stopped (idempotent) vs absent.
  const existing = await getSessionById(db, args);
  return existing ? { id: existing.id, status: 'stopped' } : null;
}

// --- resumeSession --------------------------------------------------------------

export type ResumeSessionResult =
  | { ok: true; session: SessionRecord; supersededSessionId: string | null }
  | { ok: false; reason: 'not_found' | 'not_resumable' };

/** The one stopped → active write (shared by Resume and play-track's resume). */
function resumeLifecycleSet(now: Date) {
  return {
    status: 'active',
    lastResumedAt: now,
    generationStatus: 'ok',
    generationStatusScope: null,
    statusMessageSafe: null,
    endReason: null,
    stoppedAt: null,
  } as const;
}

/**
 * Resume a Stopped session in place: re-activate the SAME identity
 * (stored Style Snapshot + queue position), set `lastResumedAt`, reset
 * `generationStatus` to `ok`, and clear `endReason`/the safe message — while
 * superseding the owner's current active session. NEVER cost-gated (the route does
 * not run the headroom gate here). The opening buffer is reseeded by the worker
 * controller from the session's own surviving Ephemeral tracks → Saved → snapshot.
 */
export async function resumeSession(
  db: Database,
  args: { ownerUserId: string; sessionId: string; now?: Date },
): Promise<ResumeSessionResult> {
  const now = args.now ?? new Date();
  return withOwnerGenerationLock(db, args.ownerUserId, async (tx) => {
    const target = await getSessionById(tx, args);
    if (!target || target.deleteRequestedAt) {
      return { ok: false as const, reason: 'not_found' as const };
    }
    if (
      target.status !== 'stopped' ||
      !canTransition('activitySessionStatus', 'stopped', 'active')
    ) {
      return { ok: false as const, reason: 'not_resumable' as const };
    }

    const supersededSessionId = await supersedeActiveSession(tx, args.ownerUserId, now);

    const [session] = await tx
      .update(activitySessions)
      .set(resumeLifecycleSet(now))
      .where(
        and(
          eq(activitySessions.id, args.sessionId),
          eq(activitySessions.ownerUserId, args.ownerUserId),
          eq(activitySessions.status, 'stopped'),
          sessionNotPendingDelete(),
        ),
      )
      .returning(sessionColumns);
    // No row: a delete was requested after the read above; throwing rolls back the supersede.
    if (!session) throw new Error('Resume lost the session to a pending delete.');
    // The lifecycle move must be exactly stopped → active, same identity.
    assertResumeReactivates({ id: target.id, status: 'stopped' }, session);
    return { ok: true as const, session, supersededSessionId };
  });
}

// --- playSessionTrack -----------------------------------------------------------

export type PlaySessionTrackResult =
  | { ok: true; session: SessionRecord; supersededSessionId: string | null }
  | { ok: false; reason: 'not_found' | 'track_not_in_session' };

/**
 * Position a session at one of its own Tracks and make it the owner's active
 * session: a Stopped session resumes (the same lifecycle write as Resume,
 * superseding the current active one), an Active session only moves its queue
 * cursor. The client then engages and the controller's resume-position logic
 * starts at the chosen item. Never cost-gated — like Resume, it plays what the
 * session already has.
 */
export async function playSessionTrack(
  db: Database,
  args: { ownerUserId: string; sessionId: string; trackId: string; now?: Date },
): Promise<PlaySessionTrackResult> {
  const now = args.now ?? new Date();
  return withOwnerGenerationLock(db, args.ownerUserId, async (tx) => {
    const target = await getSessionById(tx, args);
    if (!target || target.deleteRequestedAt) {
      return { ok: false as const, reason: 'not_found' as const };
    }

    const queueItemId = await resolvePlayableSessionTrackSlot(tx, args);
    if (!queueItemId) return { ok: false as const, reason: 'track_not_in_session' as const };

    const resuming = target.status === 'stopped';
    const supersededSessionId = resuming
      ? await supersedeActiveSession(tx, args.ownerUserId, now)
      : null;

    const [session] = await tx
      .update(activitySessions)
      .set({
        ...(resuming ? resumeLifecycleSet(now) : {}),
        currentQueueItemId: queueItemId,
        currentTrackId: args.trackId,
        lastPlaybackPositionSeconds: 0,
      })
      .where(
        and(
          eq(activitySessions.id, args.sessionId),
          eq(activitySessions.ownerUserId, args.ownerUserId),
          resuming ? eq(activitySessions.status, 'stopped') : undefined,
          sessionNotPendingDelete(),
        ),
      )
      .returning(sessionColumns);
    // No row: a delete was requested after the read above; throwing rolls back the supersede.
    if (!session) throw new Error('Play lost the session to a pending delete.');
    if (resuming) assertResumeReactivates({ id: target.id, status: 'stopped' }, session);
    return { ok: true as const, session, supersededSessionId };
  });
}

// --- restyleSession (Change Vibe) ----------------------------------------------

export type RestyleSessionResult =
  { ok: true; session: SessionRecord } | { ok: false; reason: 'not_found' | 'not_active' };

/**
 * Re-style the CURRENT session in place: same identity, stays `active`,
 * new Style Snapshot. Never creates a second session and never moves the lifecycle.
 */
export async function restyleSession(
  db: Database,
  args: {
    ownerUserId: string;
    sessionId: string;
    snapshot: StyleSnapshot;
    targetDurationMinutes?: number | null;
    coverConcept?: string | null;
    /** The re-derivation's answer on whether the request includes the listener. */
    includesListener: boolean;
    /** The change's free text, FOLDED INTO the session's prompt history rather
     *  than replacing it (`extendPromptHistory`). Null/omitted — a controls
     *  change — leaves the history exactly as it is. */
    userPromptAddition?: string | null;
    structuredControls?: StructuredControls | null;
    /** Switch-now: arm the cutover at the revision this restyle mints. A plain
     *  (false/omitted) change CLEARS any armed switch — choosing play-out
     *  supersedes an earlier switch-now. */
    switchImmediately?: boolean;
  },
): Promise<RestyleSessionResult> {
  return withOwnerGenerationLock(db, args.ownerUserId, async (tx) => {
    // The prompt history is the one field composed in application code rather
    // than by a SET expression, so its read must be serialized against a
    // concurrent restyle or two changes would compose from the same base and
    // one text would be lost. `FOR NO KEY UPDATE`: nothing here touches the
    // key, so this must not block the `KEY SHARE` locks taken by inserts that
    // reference the session (queue items, generation requests).
    const [before] = await tx
      .select(sessionColumns)
      .from(activitySessions)
      .where(
        and(
          eq(activitySessions.id, args.sessionId),
          eq(activitySessions.ownerUserId, args.ownerUserId),
        ),
      )
      .limit(1)
      .for('no key update');
    if (!before) return { ok: false as const, reason: 'not_found' as const };
    if (before.status !== 'active') return { ok: false as const, reason: 'not_active' as const };

    // A change's message EXTENDS the stored history; a controls change carries
    // none, and rewriting the value read under this row's lock leaves it
    // exactly as it stands. A history that would come out blank stays null —
    // `''` reads as a prompt that exists but says nothing.
    const userPrompt = args.userPromptAddition
      ? extendPromptHistory(before.userPrompt, args.userPromptAddition) || null
      : before.userPrompt;

    // The track-title pool is append-only, and the caller built its snapshot
    // from a read taken before its LLM round trip: a pool a worker refill grew
    // in that window is kept, not rolled back.
    const livePool = before.sessionStyleSnapshot?.trackTitles ?? [];
    const snapshot =
      livePool.length > (args.snapshot.trackTitles?.length ?? 0)
        ? { ...args.snapshot, trackTitles: livePool }
        : args.snapshot;

    const [session] = await tx
      .update(activitySessions)
      .set({
        sessionStyleSnapshot: snapshot,
        ...(args.targetDurationMinutes !== undefined
          ? { targetDurationMinutes: args.targetDurationMinutes }
          : {}),
        ...durationTargetMode(args.targetDurationMinutes),
        // The revision increment rides THE SAME UPDATE as the snapshot replacement:
        // there is never a window where the new snapshot is visible with the old
        // revision, so a concurrent buffer tick can never stamp a submit with a
        // new-vibe style under an old-vibe revision.
        styleRevision: sql`${activitySessions.styleRevision} + 1`,
        // SET expressions read the OLD row, so `styleRevision + 1` here equals the
        // revision this same UPDATE mints — armed and bumped atomically.
        vibeSwitchRevision: args.switchImmediately
          ? sql`${activitySessions.styleRevision} + 1`
          : null,
        // The Name is NEVER touched: a vibe change redirects the music,
        // not the identity the owner recognises the Session by.
        ...(args.coverConcept !== undefined
          ? {
              coverConcept: args.coverConcept
                ? sanitizeCoverConcept(args.coverConcept) || null
                : null,
            }
          : {}),
        includesListener: args.includesListener,
        userPrompt,
        ...(args.structuredControls !== undefined
          ? { structuredControls: args.structuredControls }
          : {}),
      })
      .where(
        and(
          eq(activitySessions.id, args.sessionId),
          eq(activitySessions.ownerUserId, args.ownerUserId),
          eq(activitySessions.status, 'active'),
        ),
      )
      .returning(sessionColumns);
    if (!session) return { ok: false as const, reason: 'not_active' as const };
    assertChangeVibePreservesSession(before, session);
    return { ok: true as const, session };
  });
}

// --- renameSession (Given Name) -------------------------------------------------

/**
 * Replace the Session Name with the owner's own text (one-way and
 * cosmetic — nothing re-derives over it, and it carries no feedback meaning).
 * Validation (non-blank, bounded) lives at the API edge; this is the plain
 * owner-scoped write. Null when the session is absent/not owned.
 */
export async function renameSession(
  db: Database,
  args: { ownerUserId: string; sessionId: string; title: string },
): Promise<SessionRecord | null> {
  const [session] = await db
    .update(activitySessions)
    .set({ title: args.title })
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    )
    .returning(sessionColumns);
  return session ?? null;
}

// --- setSessionDuration (the Session duration target) ---------------------------

/** Target edits share paid-submit serialization, so admission always sees the committed target. */
export async function setSessionDuration(
  db: Database,
  args: {
    ownerUserId: string;
    sessionId: string;
    targetDurationMinutes?: number | null;
    /** Lands with the target, so choosing No limit can never half-apply. */
    sessionMode?: 'keep_going' | 'repeat';
  },
): Promise<SessionRecord | null> {
  return withOwnerGenerationLock(db, args.ownerUserId, async (tx) => {
    if (args.targetDurationMinutes === undefined && args.sessionMode === undefined) {
      return getSessionById(tx, args);
    }
    const [session] = await tx
      .update(activitySessions)
      .set({
        ...(args.targetDurationMinutes !== undefined
          ? { targetDurationMinutes: args.targetDurationMinutes }
          : {}),
        ...(args.sessionMode ? { sessionMode: args.sessionMode } : {}),
        ...durationTargetMode(args.targetDurationMinutes),
      })
      .where(
        and(
          eq(activitySessions.id, args.sessionId),
          eq(activitySessions.ownerUserId, args.ownerUserId),
        ),
      )
      .returning(sessionColumns);
    return session ?? null;
  });
}

// --- setSessionMode (the player's mode switch) ----------------------------------

/**
 * Write the session's generation policy (`sessionMode`) — user intent, the only
 * writer after creation seeds the starting mode (the worker merely consumes it).
 * Owner-scoped; null when the session is absent/not owned.
 */
export async function setSessionMode(
  db: Database,
  args: { ownerUserId: string; sessionId: string; mode: 'keep_going' | 'repeat' },
): Promise<SessionRecord | null> {
  const [session] = await db
    .update(activitySessions)
    .set({ sessionMode: args.mode })
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    )
    .returning(sessionColumns);
  return session ?? null;
}

// --- getSeedSnapshot (More Like This) -------------------------------------------

/**
 * The outcome of resolving a More Like This seed, kept as a discriminated result so
 * the route never conflates "a readable seed exists but its session has no snapshot"
 * (a legitimate default-controls fallback) with "no readable seed exists at all" (a
 * bogus / cross-owner-private / revoked / nonexistent id). The latter MUST NOT
 * create a session or trigger paid generation — the track-seeded contract plus the
 * one read scope: the viewer's own tracks, or Lounge-audible ones.
 * `foreignSeed` marks a seed the viewer does not own, so the caller strips the
 * sharer's personal ingredients (Own Voice, People notes) before reusing the style.
 */
export type SeedSnapshotResult =
  | { kind: 'snapshot'; snapshot: StyleSnapshot; foreignSeed: boolean }
  | { kind: 'readable-no-snapshot' }
  | { kind: 'no-readable-seed' };

/**
 * Resolve the Style Snapshot that produced one of the seed tracks. Scans the seed
 * ids in the widened READ scope (`viewerCanReadTrack`: owner OR Lounge-audible):
 * returns the first readable seed whose originating session carries a
 * snapshot (`{kind:'snapshot'}` — a track-seeded Start Session reuses it as its
 * frozen style, no text-LLM call). If at least one seed is a readable track but
 * none carries a snapshot, returns `{kind:'readable-no-snapshot'}` (the route may
 * fall back to default controls). If NONE of the ids is readable, returns
 * `{kind:'no-readable-seed'}` so the route can reject without creating anything —
 * unknown, private, and revoked ids stay indistinguishable.
 */
export async function getSeedSnapshot(
  db: Database,
  args: { viewerUserId: string; seedTrackIds: string[] },
): Promise<SeedSnapshotResult> {
  if (args.seedTrackIds.length === 0) return { kind: 'no-readable-seed' };
  // One read-scoped query for every seed; LEFT JOIN the originating session so
  // a missing request/session (or a null snapshot) still proves a seed is
  // readable. The seed-id ORDER decides which snapshot wins, so it is applied
  // in JS. The request's frozen copy is the style that made the Track; the
  // Session's live snapshot may carry a later Change Vibe, so it is only the
  // fallback for requests that never froze one.
  const rows = await db
    .select({
      trackId: tracks.id,
      trackOwnerUserId: tracks.ownerUserId,
      snapshot: sql<StyleSnapshot | null>`coalesce(${generationRequests.styleSnapshot}, ${activitySessions.sessionStyleSnapshot})`,
    })
    .from(tracks)
    .leftJoin(generationRequests, eq(tracks.generationRequestId, generationRequests.id))
    .leftJoin(activitySessions, eq(generationRequests.activitySessionId, activitySessions.id))
    .where(and(inArray(tracks.id, args.seedTrackIds), viewerCanReadTrack(args.viewerUserId)));
  const rowByTrackId = new Map(rows.map((row) => [row.trackId, row]));
  for (const trackId of args.seedTrackIds) {
    const row = rowByTrackId.get(trackId);
    if (row?.snapshot) {
      return {
        kind: 'snapshot',
        snapshot: row.snapshot,
        foreignSeed: row.trackOwnerUserId !== args.viewerUserId,
      };
    }
  }
  return rows.length > 0 ? { kind: 'readable-no-snapshot' } : { kind: 'no-readable-seed' };
}

// --- reportPlaybackState --------------------------------------------------------

export interface ReportPlaybackStateInput {
  ownerUserId: string;
  sessionId: string;
  clientId: string;
  /**
   * Client-minted idempotency key for THIS logical playback event. A retry reuses
   * the same id so persisted events (started/ended/skipped/failed) dedupe and never
   * double-count. `position` pings carry one too but never persist, so it is ignored
   * for them.
   */
  clientEventId: string;
  type: PlaybackReportType;
  trackId: string | null;
  queueItemId: string | null;
  positionSeconds: number | null;
  clientTimestamp: Date;
  /**
   * True on a `started` born from the Queue-loop restart: forward navigation
   * wrapped past the end of the projection. Proves every set-aside in the session
   * was walked past — however late the report lands, the wrap itself happened.
   */
  queueWrapped?: boolean;
  /**
   * True on a `started` chosen by client-side Shuffle traversal. Queue order then
   * says nothing about what was heard: earlier `queued` slots are still in the
   * shuffle bag, so they stay `queued` instead of self-healing to `skipped`.
   */
  shuffled?: boolean;
  now?: Date;
}

export type ReportPlaybackStateResult =
  | {
      ok: true;
      persistedEvent: boolean;
      bufferEnqueued: boolean;
      activePlaybackClientId: string;
    }
  /**
   * `not_found`: the session is absent or not owned. `invalid_reference`: the
   * report carried a `queueItemId`/`trackId` that is not part of THIS session/owner
   * (an IDOR attempt) — rejected before any write.
   */
  | { ok: false; reason: 'not_found' | 'invalid_reference' };

const PERSISTED_EVENT_TYPES: readonly PersistedPlaybackEventType[] = [
  'started',
  'ended',
  'skipped',
  'failed',
];

function isPersistedEventType(type: PlaybackReportType): type is PersistedPlaybackEventType {
  return (PERSISTED_EVENT_TYPES as readonly string[]).includes(type);
}

/** What a persisted playback event does to the reported queue item's state. */
const QUEUE_ITEM_EVENT_TARGETS = {
  ended: 'played',
  skipped: 'skipped',
  failed: 'failed',
} as const;

/**
 * Advance queue-item lifecycle state from a FRESH persisted playback report (the
 * `'playback-state-api'` writer in `STATE_MACHINE_WRITERS.queueItemState`). Every
 * write is a state-guarded conditional UPDATE mirroring `QUEUE_ITEM_TRANSITIONS`,
 * so a replayed or out-of-order report can never make an illegal move — it simply
 * matches no row. Runs inside the report's dedupe transaction, so a deduped retry
 * never re-applies a transition.
 *
 * `started` moves the reported item `queued → playing` and also self-heals slots a
 * lost report left behind — strictly at EARLIER positions, so a fresh `started`
 * that arrives late/out of order for an earlier item can never touch the item
 * currently playing: prior items still `playing` are closed out as `played` (their
 * `ended` never landed), and prior items still `queued` become `skipped` (advanced
 * past before they started) — unless the start is shuffled, where earlier slots
 * may simply not have come up yet. Earlier switch-now set-asides lose their
 * `vibeSwitchSetAside` flag under the same guard — the cutover's job is done, and
 * the slot rejoins ordinary skipped history. `ended` completes the item (`played`)
 * even straight from `queued` (its `started` was lost — the start is implied);
 * `skipped`/`failed` map directly.
 */
async function applyQueueItemTransitions(
  tx: Transaction,
  args: {
    sessionId: string;
    queueItemId: string;
    position: number;
    eventType: PersistedPlaybackEventType;
    /** Widens the started flag-clear to the whole session (Queue-loop restart). */
    queueWrapped: boolean;
    /** Keeps earlier `queued` slots `queued` (Shuffle traversal). */
    shuffled: boolean;
  },
): Promise<void> {
  const inThisSession = eq(activitySessionQueueItems.activitySessionId, args.sessionId);
  const earlierInSession = (condition: SQL): SQL | undefined =>
    and(inThisSession, condition, lt(activitySessionQueueItems.position, args.position));

  if (args.eventType === 'started') {
    // Clearing the flag puts the slot back in reach when the Queue loops around,
    // exactly like a user-skipped one; a set-aside that playback has NOT yet passed
    // must keep steering navigation around the old vibe, hence the strictly-earlier
    // bound. A WRAPPED started widens the clear to the whole session: the loop
    // restart proves navigation walked past every set-aside — including one
    // trailing the last slot that ever starts, which no strictly-earlier sweep can
    // reach — and the wrap happened client-side however late its report lands.
    const setAside = eq(activitySessionQueueItems.vibeSwitchSetAside, true);
    await tx
      .update(activitySessionQueueItems)
      .set({ vibeSwitchSetAside: false })
      .where(args.queueWrapped ? and(inThisSession, setAside) : earlierInSession(setAside));
    await tx
      .update(activitySessionQueueItems)
      .set({ state: 'played' })
      .where(earlierInSession(eq(activitySessionQueueItems.state, 'playing')));
    if (!args.shuffled) {
      await tx
        .update(activitySessionQueueItems)
        .set({ state: 'skipped' })
        .where(earlierInSession(eq(activitySessionQueueItems.state, 'queued')));
    }
    await tx
      .update(activitySessionQueueItems)
      .set({ state: 'playing' })
      .where(
        and(
          eq(activitySessionQueueItems.id, args.queueItemId),
          eq(activitySessionQueueItems.state, 'queued'),
        ),
      );
    return;
  }

  await tx
    .update(activitySessionQueueItems)
    .set({ state: QUEUE_ITEM_EVENT_TARGETS[args.eventType] })
    .where(
      and(
        eq(activitySessionQueueItems.id, args.queueItemId),
        inArray(activitySessionQueueItems.state, ['queued', 'playing']),
      ),
    );
}

/**
 * Apply a playback report to the owner's session: a fresh/landing report makes its
 * reporter the active playback client (single-controller) and updates the
 * live fields; a DEDUPED persisted retry is the intentional exception — it changes
 * nothing and leaves the active client exactly as the original landing left it.
 * started/ended/skipped/failed persist a `playback_events` row (a `position` ping
 * updates live fields only — no row), and — when the report references a queue
 * item — advance that item's lifecycle state in the same transaction (see
 * `applyQueueItemTransitions`), which is what lets `countReadyAheadTracks` drop as
 * tracks play so the buffer controller keeps generating (the Queue actually
 * loops). Returns `{ok:false, reason:'not_found'}` when
 * the session is absent/not owned, and `{ok:false, reason:'invalid_reference'}` when
 * a supplied `queueItemId`/`trackId` is not part of this session/owner (an IDOR
 * attempt) — both reject before any write.
 *
 * Buffer top-up is not enqueued here: the worker's `sweep-active-sessions` job tops
 * up every active session. The returned `bufferEnqueued` therefore reports whether
 * the report WARRANTS a top-up (a fresh started/ended/skipped), which the sweep will
 * perform.
 */
export async function reportPlaybackState(
  db: Database,
  input: ReportPlaybackStateInput,
): Promise<ReportPlaybackStateResult> {
  const now = input.now ?? new Date();
  // Owner-scoped existence check + the prior active client (for latest-wins resolve).
  const [row] = await db
    .select({
      id: activitySessions.id,
      activePlaybackClientId: activitySessions.activePlaybackClientId,
    })
    .from(activitySessions)
    .where(
      and(
        eq(activitySessions.id, input.sessionId),
        eq(activitySessions.ownerUserId, input.ownerUserId),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, reason: 'not_found' };

  // Owner-scoping the SESSION is not enough: a client could pass a `queueItemId` /
  // `trackId` it doesn't own (IDOR). Validate any supplied reference belongs to THIS
  // session / owner BEFORE any write, so a bogus reference is rejected with no row
  // and no live-field mutation.
  // The queue slot this report targets (id + position), for the lifecycle
  // transitions below. Null when the report references no queued slot at all.
  let reportedQueueItem: { id: string; position: number } | null = null;
  let queueItemTrackId: string | null = null;
  if (input.queueItemId) {
    const [queueItem] = await db
      .select({
        trackId: activitySessionQueueItems.trackId,
        position: activitySessionQueueItems.position,
      })
      .from(activitySessionQueueItems)
      .where(
        and(
          eq(activitySessionQueueItems.id, input.queueItemId),
          eq(activitySessionQueueItems.activitySessionId, input.sessionId),
        ),
      )
      .limit(1);
    if (!queueItem) return { ok: false, reason: 'invalid_reference' };
    queueItemTrackId = queueItem.trackId;
    reportedQueueItem = { id: input.queueItemId, position: queueItem.position };
  }
  if (input.trackId) {
    const [track] = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(and(eq(tracks.id, input.trackId), eq(tracks.ownerUserId, input.ownerUserId)))
      .limit(1);
    if (!track) return { ok: false, reason: 'invalid_reference' };
  }
  // When both are present they must agree: the reported track must be the one the
  // queue item carries (no mixing a valid queue slot with an unrelated owned track).
  if (input.queueItemId && input.trackId && queueItemTrackId !== input.trackId) {
    return { ok: false, reason: 'invalid_reference' };
  }
  // The contract also allows track-only reports (`queueItemId: null`). Resolve the
  // session's queue slot for that track — well-defined via the partial unique index
  // `queue_items_session_track_unique` — so a track-only report still advances the
  // queue lifecycle. No slot (e.g. a library stand-in during cold start) is fine:
  // the report lands, there is just nothing to transition.
  if (!reportedQueueItem && input.trackId) {
    const [slot] = await db
      .select({ id: activitySessionQueueItems.id, position: activitySessionQueueItems.position })
      .from(activitySessionQueueItems)
      .where(
        and(
          eq(activitySessionQueueItems.activitySessionId, input.sessionId),
          eq(activitySessionQueueItems.trackId, input.trackId),
        ),
      )
      .limit(1);
    reportedQueueItem = slot ?? null;
  }

  // Single-controller: a LANDING report makes its reporter the active
  // playback client (`resolveActivePlaybackClient` → reporting client wins). This is
  // applied only when the report actually lands — never on a deduped retry.
  const { activeClientId } = resolveActivePlaybackClient(
    row.activePlaybackClientId,
    input.clientId,
  );
  const isStart = input.type === 'started';
  const liveFields = {
    activePlaybackClientId: activeClientId,
    lastPlaybackReportAt: now,
    ...(input.positionSeconds != null
      ? { lastPlaybackPositionSeconds: input.positionSeconds }
      : {}),
    ...(isStart && input.trackId ? { currentTrackId: input.trackId } : {}),
    // The RESOLVED slot (not the raw input): a track-only started must move both
    // cursor pointers together, or currentQueueItemId would keep pointing at the
    // previous item while currentTrackId already names the new track. A slotless
    // track (library stand-in) moves only currentTrackId — there is no slot to name.
    ...(isStart && reportedQueueItem ? { currentQueueItemId: reportedQueueItem.id } : {}),
  };

  // Position pings persist no row and carry no dedupe obligation: update live fields
  // only and return (no buffer top-up).
  if (!isPersistedEventType(input.type)) {
    await db
      .update(activitySessions)
      .set(liveFields)
      .where(eq(activitySessions.id, input.sessionId));
    return {
      ok: true,
      persistedEvent: false,
      bufferEnqueued: false,
      activePlaybackClientId: activeClientId,
    };
  }
  // Capture the narrowed persisted type in a const: control-flow narrowing of
  // `input.type` does not survive into the transaction callback closure below.
  const eventType = input.type;

  // Persisted event — idempotency is enforced INSERT-FIRST so a deduped retry never
  // mutates live state. The dedupe insert and the conditional live-field update run
  // in ONE transaction: insert with ON CONFLICT (activity_session_id, client_event_id)
  // DO NOTHING. If a row was written the report is FRESH → apply the live-field update
  // and warrant a buffer top-up. If it CONFLICTED the report is a delayed retry → SKIP
  // the update entirely, so lastPlaybackReportAt (which drives idle auto-stop AND
  // Ephemeral eviction recency), activePlaybackClientId, and the current pointers stay
  // EXACTLY as the original landing left them — a retry dedupes and never double-counts.
  return withTransaction(db, async (tx) => {
    const inserted = await tx
      .insert(playbackEvents)
      .values({
        ownerUserId: input.ownerUserId,
        activitySessionId: input.sessionId,
        eventType,
        clientEventId: input.clientEventId,
        queueItemId: input.queueItemId,
        trackId: input.trackId,
        positionSeconds: input.positionSeconds,
        clientTimestamp: input.clientTimestamp,
      })
      .onConflictDoNothing({
        target: [playbackEvents.activitySessionId, playbackEvents.clientEventId],
      })
      .returning({ id: playbackEvents.id });

    if (inserted.length === 0) {
      // Deduped retry: leave every live field untouched and report the UNCHANGED
      // active controller (the value the original landing committed) — never a reclaim.
      return {
        ok: true as const,
        persistedEvent: true,
        bufferEnqueued: false,
        activePlaybackClientId: row.activePlaybackClientId ?? input.clientId,
      };
    }

    // The Session row is locked before any queue item, the order the switch-now
    // cutover takes them in; the reverse order deadlocks against it.
    await tx
      .update(activitySessions)
      .set(liveFields)
      .where(eq(activitySessions.id, input.sessionId));

    // A fresh report also advances the reported queue item's lifecycle — without
    // this, items sit in `queued` forever, `countReadyAheadTracks` keeps counting
    // already-played tracks, and the buffer controller stops generating after the
    // first fill (the session starves).
    if (reportedQueueItem) {
      await applyQueueItemTransitions(tx, {
        sessionId: input.sessionId,
        queueItemId: reportedQueueItem.id,
        position: reportedQueueItem.position,
        eventType,
        queueWrapped: input.queueWrapped ?? false,
        shuffled: input.shuffled ?? false,
      });
    }

    const bufferEnqueued =
      input.type === 'started' || input.type === 'ended' || input.type === 'skipped';
    return {
      ok: true as const,
      persistedEvent: true,
      bufferEnqueued,
      activePlaybackClientId: activeClientId,
    };
  });
}
