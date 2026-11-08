// Canonical state literals for Liedmotif's state-machine contract.
//
// These ordered arrays are the lowest-level, framework-free declaration of the
// value domains the app's four state machines reason about. They MUST stay
// byte-for-byte equal to the Drizzle `pgEnum` value lists in
// `packages/db/src/schema/enums.ts`. We keep two declarations (DB owns the column
// value domain; `@liedmotif/shared` owns the transition semantics) rather than
// importing one into the other; a test deep-equals the live
// `pgEnum(...).enumValues` against the arrays below, so they can never drift.
//
// Order matters: it mirrors the `pgEnum` declaration order so that comparison
// holds and callers can rely on a stable ordering.

/**
 * Session lifecycle (`activity_sessions.status`). Exactly two states:
 * a session is the at-most-one live `active` session
 * or `stopped`. There is no `paused`/`completed` — a running session that hits a
 * cost limit degrades to Session Repeat (a `generationStatus`, never a lifecycle
 * state), and every exit (user stop, supersede, idle auto-stop)
 * lands on `stopped`, which Resume can re-activate.
 */
export const ACTIVITY_SESSION_STATUSES = ['active', 'stopped'] as const;
export type ActivitySessionStatus = (typeof ACTIVITY_SESSION_STATUSES)[number];

/** Queue-item state (`activity_session_queue_items.state`). */
export const QUEUE_ITEM_STATES = [
  'planned',
  'generating',
  'queued',
  'playing',
  'played',
  'skipped',
  'rejected',
  'failed',
] as const;
export type QueueItemState = (typeof QUEUE_ITEM_STATES)[number];

/** Provider-agnostic job status (`provider_jobs.normalizedStatus`). */
export const PROVIDER_NORMALIZED_STATUSES = [
  'queued',
  'submitted',
  'submit_unknown',
  'submit_rejected',
  'processing',
  'partially_ready',
  'ready',
  'failed_retryable',
  'failed_final',
  'blocked_by_liedmotif_limit',
  'blocked_by_provider_credits',
  'provider_rate_limited',
  'blocked_by_policy',
] as const;
export type ProviderNormalizedStatus = (typeof PROVIDER_NORMALIZED_STATUSES)[number];

/** Track readiness/lifecycle (`tracks.status`). */
export const TRACK_STATUSES = [
  'pending',
  'streamable',
  'ready',
  'rejected',
  'deleted',
  'failed',
] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

/**
 * Why a session became Stopped (`activity_sessions.endReason`, nullable). Recorded
 * on the lifecycle exit — not a state — so the two-state `status` stays clean:
 *
 * - `user_stopped`      — an explicit user Stop.
 * - `completed_duration`— historical elapsed-duration completion, retained for stored rows.
 * - `superseded`        — Start Session / More Like This / Resume replaced it
 *                         (`SUPERSEDED_SESSION_STATUS`).
 * - `idle_timeout`      — the worker idle sweep auto-stopped an idle active session
 *                         (resumable from My Sessions).
 */
export const SESSION_END_REASONS = [
  'user_stopped',
  'completed_duration',
  'superseded',
  'idle_timeout',
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/**
 * The generation-controller status (`activity_sessions.generationStatus`).
 * "Limit reached" and other generation blocks are a property of the
 * Buffer / generation controller — **never** a lifecycle state — so a session
 * stays `active` while generation is degraded:
 *
 * - `ok`                   — generating normally.
 * - `repeat_cost_limit`    — cost limit hit mid-listen → Session Repeat (loop the
 *                            session's own tracks at zero cost; auto-resumes when
 *                            the limit window rolls over). The cost-limit case is a
 *                            controller status, not the old `liedmotif_limit` pause.
 * - `repeat_buffer_complete` — LEGACY: never emitted by the controller ("play
 *                            existing Tracks" is the session's own `repeat`
 *                            mode, not a controller status). Kept in the enum
 *                            for stored rows — removing a Postgres enum value
 *                            needs a type rebuild; the next tick rewrites it.
 * - `provider_credits`     — provider credits unavailable.
 * - `provider_rate_limited`— provider backoff / rate limit.
 * - `worker_stalled`       — the worker is not making progress.
 * - `provider_error`       — provider generation failed.
 */
export const SESSION_GENERATION_STATUSES = [
  'ok',
  'repeat_cost_limit',
  'repeat_buffer_complete',
  'provider_credits',
  'provider_rate_limited',
  'worker_stalled',
  'provider_error',
] as const;
export type SessionGenerationStatus = (typeof SESSION_GENERATION_STATUSES)[number];

/**
 * The `generationStatus` values under which no new tracks are coming, so the
 * player loops the Session's own buffered set (Session Repeat) instead of
 * waiting at the end of the queue: the involuntary cost-limit degrade, plus the
 * legacy `repeat_buffer_complete` stored on older rows. The worker's
 * buffer controller produces these; the player consumes them — this constant
 * is that cross-layer contract. (The voluntary case needs no status: the player
 * also loops on `sessionMode='repeat'` directly.)
 */
export const SESSION_REPEAT_GENERATION_STATUSES = [
  'repeat_cost_limit',
  'repeat_buffer_complete',
] as const satisfies readonly SessionGenerationStatus[];

/** Whether the player should loop the Session's own set under this status. */
export function isSessionRepeatGenerationStatus(status: SessionGenerationStatus): boolean {
  return (SESSION_REPEAT_GENERATION_STATUSES as readonly SessionGenerationStatus[]).includes(
    status,
  );
}

/**
 * A session's generation policy (`activity_sessions.sessionMode`) — the sole
 * authority over fresh music-model calls; the owner's
 * `bufferEnabled` setting only picks which mode a NEW session starts in
 * (`defaultSessionMode`). `keep_going` generates new tracks indefinitely;
 * `repeat` stops generating and loops the session's own tracks at zero cost —
 * the *voluntary* form of Session Repeat (a cost limit triggers the involuntary
 * form via `generationStatus = 'repeat_cost_limit'`). Only a Style Snapshot
 * revision's initial fill (cold start, a new Change Vibe revision) generates in
 * either mode; the Dislike reroll's fresh call is `keep_going`-only.
 */
export const SESSION_MODES = ['keep_going', 'repeat'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

// --- Track user-state flags --------------------------------------------------
// Saved/favorite/dislike state lives on `tracks` flags + `feedback_events`
// — there is NO `ratings` table. The flags are nullable
// timestamps; "set" means non-null. Modeled here so contracts and the buffer/
// feedback code share one notion of retention class.

/** Any timestamp-like value; only its presence (non-null) is meaningful here. */
export type FlagTimestamp = Date | string | number | null | undefined;

/** The three track user-state flags (`tracks.savedAt/favoritedAt/dislikedAt`). */
export interface TrackUserState {
  savedAt: FlagTimestamp;
  favoritedAt: FlagTimestamp;
  dislikedAt: FlagTimestamp;
}

/** A flag is "set" when it carries a non-null timestamp. */
export function isFlagSet(value: FlagTimestamp): boolean {
  return value !== null && value !== undefined;
}

/**
 * Retention class — what governs when a track's audio file dies. A
 * derived view over the flags, never stored, so it is intentionally NOT a DB enum
 * (no parity row).
 */
export const TRACK_RETENTION_CLASSES = ['reject', 'durable', 'ephemeral'] as const;
export type TrackRetentionClass = (typeof TRACK_RETENTION_CLASSES)[number];

/**
 * Derive the retention class from the flags. Precedence: a
 * Disliked track is **Reject** (fast-delete) regardless of any other flag; else a
 * Saved/Favorited track is **Durable**; else **Ephemeral**.
 */
export function deriveTrackRetentionClass(state: TrackUserState): TrackRetentionClass {
  if (isFlagSet(state.dislikedAt)) return 'reject';
  if (isFlagSet(state.savedAt)) return 'durable';
  return 'ephemeral';
}

/**
 * Enforce the documented flag invariant: `favoritedAt ⇒ savedAt` (Favorite
 * implies Save, the retention floor). Throws on violation.
 */
export function assertTrackUserStateInvariants(state: TrackUserState): void {
  if (isFlagSet(state.favoritedAt) && !isFlagSet(state.savedAt)) {
    throw new Error(
      'Track user-state invariant violated: favoritedAt is set but savedAt is not (Favorite implies Save).',
    );
  }
}
