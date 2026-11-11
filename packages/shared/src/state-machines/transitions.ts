// Legal-transition maps + a validator for Liedmotif's four state machines.
//
// The maps below are the binding "what move is legal" half of the state-machine
// contract; the literals in `./literals` are the value domain. Each map is
// change-only: a self-transition (`from === to`) is NOT modeled as a transition
// (callers treat an idempotent re-write of the same value as a no-op, not a
// move), and a terminal state has an empty target list.
//
// Legal WRITERS per machine (who is allowed to write the column) are documented
// on each map and captured as data in `STATE_MACHINE_WRITERS` so the rule is
// importable, not just prose:
//
//   - activitySessionStatus  — API routes (user intent) + worker (terminal
//                              cleanup; the idle sweep moves active→stopped).
//   - queueItemState         — the buffer controller + playback/user-action APIs.
//   - providerNormalizedStatus — worker jobs ONLY.
//   - trackStatus            — worker jobs (provider/storage readiness), feedback
//                              actions (rejection), and explicit owner deletion.
//
// `generationStatus` and `sessionMode` are session FIELDS, not transition graphs
// (generation/limit status is controller state, never a lifecycle
// state), so they are absent from the transition registry; their writers are
// recorded separately in `SESSION_FIELD_WRITERS`.
//
// Cross-machine invariants the maps cannot express on their own are encoded as
// helpers below (one active session per user; Change Vibe never changes identity
// or status; Resume re-activates a Stopped session in place;
// Start/More-Like-This/Resume supersede the prior active session; latest
// reportPlaybackState wins the active playback client).

import {
  ACTIVITY_SESSION_STATUSES,
  PROVIDER_NORMALIZED_STATUSES,
  QUEUE_ITEM_STATES,
  TRACK_STATUSES,
  type ActivitySessionStatus,
  type ProviderNormalizedStatus,
  type QueueItemState,
  type TrackStatus,
} from './literals';

type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

/**
 * `activity_sessions.status` — two states only. Writers: API routes for user intent; worker for terminal cleanup /
 * the idle sweep.
 *
 * - `active`  → `stopped`  (every exit lands here: an explicit user Stop
 *                           [`endReason='user_stopped'`], supersession by Start
 *                           Session / More Like This / Resume [`'superseded'`],
 *                           or the worker idle sweep [`'idle_timeout'`]). A cost or
 *                           duration limit hit mid-listen
 *                           does NOT stop the session — it degrades to Session
 *                           Repeat, never a lifecycle move.
 * - `stopped` → `active`   (Resume Session re-activates the same identity).
 *
 * Neither state is terminal: a Stopped session is always resumable.
 */
export const ACTIVITY_SESSION_TRANSITIONS: TransitionMap<ActivitySessionStatus> = {
  active: ['stopped'],
  stopped: ['active'],
};

/**
 * `activity_session_queue_items.state` (writers: buffer controller, playback API,
 * feedback actions, and explicit owner deletion).
 *
 * - `planned`    → `generating` | `queued` (a ready stand-in/sibling can fill a
 *                  slot directly) | `rejected` (owner deleted its Track) | `failed`
 * - `generating` → `queued` | `rejected` (owner deleted its Track) | `failed`
 * - `queued`     → `playing` | `played` (an `ended` report landed but its
 *                  `started` was lost in transit — the start is implied) |
 *                  `skipped` (advanced past before it started) |
 *                  `rejected` (removed by Dislike or owner deletion) |
 *                  `failed` (audio lost)
 * - `playing`    → `played` (ended) | `skipped` | `rejected` (removed by
 *                  Dislike or owner deletion) | `failed`
 * - `played` / `skipped` / `rejected` / `failed` are terminal (the slot is
 *   replaced by a fresh `planned` item, it does not transition further).
 */
export const QUEUE_ITEM_TRANSITIONS: TransitionMap<QueueItemState> = {
  planned: ['generating', 'queued', 'rejected', 'failed'],
  generating: ['queued', 'rejected', 'failed'],
  queued: ['playing', 'played', 'skipped', 'rejected', 'failed'],
  playing: ['played', 'skipped', 'rejected', 'failed'],
  played: [],
  skipped: [],
  rejected: [],
  failed: [],
};

/**
 * The non-terminal queue-item states — slots that are still on their way to (or
 * in) playback. One definition shared by the writers that clear a slot out of
 * the live set (Dislike's `→ rejected`, eviction's audio-lost `→ failed`) and by
 * the eviction guard that protects an active session's still-playable slots, so
 * "live slot" can never drift between them. Exactly the states with outgoing
 * edges in `QUEUE_ITEM_TRANSITIONS`.
 */
export const LIVE_QUEUE_ITEM_STATES = [
  'planned',
  'generating',
  'queued',
  'playing',
] as const satisfies readonly QueueItemState[];

/**
 * `provider_jobs.normalizedStatus` (writers: worker jobs ONLY).
 *
 * Submit must happen before processing, so `queued` cannot jump straight to
 * `processing`/`ready`. `submit_unknown` is terminal for the automatic machine —
 * the network failed before a taskId was captured so the provider may have taken
 * a paid call; resolution is manual/admin, never an auto-retry. `submit_rejected`
 * is terminal for the same reason and no other: the provider definitively refused
 * the call (so it charged nothing), and a rejection a retry of the SAME request
 * would only earn again is not worth re-issuing.
 *
 * `blocked_by_policy` is reachable BOTH pre-submit (kept for a pre-spend prompt
 * check; none runs today) AND post-submit (the provider rejects a
 * sensitive word during the `PENDING → TEXT_SUCCESS` polling phase, i.e. while
 * `submitted`/`processing`). It is terminal either way: a sensitive-word block
 * needs a new, user-edited request, not a retry.
 * It is NOT reachable from `partially_ready` — by then one track
 * has already cleared content checks (FIRST_SUCCESS).
 *
 * The recovery states `provider_rate_limited` and `failed_retryable` can reach
 * `ready` in one hop: a poll issued after backoff may observe `SUCCESS` directly
 * if the job finished while waiting.
 *
 * `blocked_by_provider_credits` is likewise reachable BOTH pre-submit (the submit
 * is refused for credits) AND post-submit (the poll reports an out-of-credits
 * failure for a job that holds a taskId). It is terminal: a fresh job, not this
 * one, is what lifts it once the cooldown passes.
 *
 * MONEY-SAFETY: the paid provider submit happens on a `→ submitted` transition.
 * This map closes the `→ queued` re-entry STRUCTURALLY — the recovery states do
 * NOT target `queued`, and the only edge into `queued` is the auto-resume from
 * the PRE-submit `blocked_by_liedmotif_limit` (set before any spend), which is
 * itself only reachable from `queued`. So `{queued, blocked_by_liedmotif_limit}`
 * is a closed pre-submit cluster the post-submit subgraph can never re-enter.
 *
 * But `→ submitted` itself stays reachable from the recovery states
 * (`provider_rate_limited`/`failed_retryable`) because that IS the PRE-submit retry
 * path — and this memoryless map can't tell a pre-submit recovery (no taskId yet,
 * `→ submitted` must issue the first paid call) from a post-submit one (taskId held,
 * `→ submitted` would double-charge). The map therefore CANNOT fully prevent a
 * double submit on its own. `assertNoProviderResubmitAfterTask` (below) is the
 * load-bearing guard for that case: worker submit/poll jobs MUST call it (with
 * whether the job already holds a `providerTaskId`) before writing this column.
 * Map + guard together = no paid re-submit after a taskId.
 *
 * `ready` and `failed_final` are terminal.
 */
export const PROVIDER_NORMALIZED_TRANSITIONS: TransitionMap<ProviderNormalizedStatus> = {
  queued: [
    'submitted',
    'submit_unknown',
    'submit_rejected',
    'blocked_by_liedmotif_limit',
    'blocked_by_provider_credits',
    'blocked_by_policy',
    'provider_rate_limited',
    'failed_retryable',
    'failed_final',
  ],
  submitted: [
    'processing',
    'partially_ready',
    'ready',
    'provider_rate_limited',
    'blocked_by_provider_credits',
    'blocked_by_policy',
    'failed_retryable',
    'failed_final',
  ],
  processing: [
    'partially_ready',
    'ready',
    'provider_rate_limited',
    'blocked_by_provider_credits',
    'blocked_by_policy',
    'failed_retryable',
    'failed_final',
  ],
  partially_ready: [
    'ready',
    'provider_rate_limited',
    'blocked_by_provider_credits',
    'failed_retryable',
    'failed_final',
  ],
  // No `queued` target — see MONEY-SAFETY above. Pre-submit retry → `submitted`;
  // post-submit recovery → `processing`/`partially_ready`/`ready`.
  provider_rate_limited: ['submitted', 'processing', 'partially_ready', 'ready', 'failed_final'],
  failed_retryable: ['submitted', 'processing', 'partially_ready', 'ready', 'failed_final'],
  submit_unknown: [],
  submit_rejected: [],
  blocked_by_liedmotif_limit: ['queued'],
  blocked_by_provider_credits: [],
  blocked_by_policy: [],
  ready: [],
  failed_final: [],
};

/**
 * Money-safety guard the memoryless transition map can't fully encode: a provider
 * job that already holds a `providerTaskId` must never re-enter a state that issues
 * a (paid) submit — `submitted` (the paid call) or `queued` (its precursor). The
 * map keeps `recovery → submitted` legal only to serve the PRE-submit retry (no
 * taskId yet); this guard rejects the POST-submit case. Worker submit/poll jobs
 * MUST call it before writing `providerNormalizedStatus`.
 */
export function assertNoProviderResubmitAfterTask(
  hasProviderTaskId: boolean,
  to: ProviderNormalizedStatus,
): void {
  if (hasProviderTaskId && (to === 'queued' || to === 'submitted')) {
    throw new Error(
      `Money-safety: a provider job that already holds a providerTaskId must not transition to ` +
        `"${to}" — that would re-submit and double-charge. Re-poll instead.`,
    );
  }
}

// --- Provider normalized-status classifications ------------------------------

/**
 * Provider-job statuses whose tracks are still being produced by a LIVE pipeline:
 * the poll loop advances or terminalizes them (the attempt cap ends as
 * `failed_final`). One definition shared by the buffer's in-flight slot
 * accounting, the poll safety-net scan, and the worker's stall signal, so the
 * buckets can never drift apart.
 */
export const LIVE_IN_FLIGHT_PROVIDER_STATUSES = [
  'submitted',
  'processing',
  'partially_ready',
] as const satisfies readonly ProviderNormalizedStatus[];

/**
 * Statuses whose POLL lifecycle is over: re-polling one is a no-op, and a late
 * or overlapping poll carrying a stale snapshot must never regress it back to a
 * progress status (which would resurrect a failed job and materialize tracks
 * after a terminal failure). Both halves of the poll path — the job that decides
 * whether to call the provider and the repo CAS that guards the write — read
 * this one definition, so they cannot drift.
 */
export const POLL_TERMINAL_PROVIDER_STATUSES = [
  'ready',
  'failed_final',
  'blocked_by_provider_credits',
  'blocked_by_policy',
  'submit_unknown',
  'submit_rejected',
] as const satisfies readonly ProviderNormalizedStatus[];

/**
 * Parked submits hold no provider task to poll, so no Track can ever arrive from
 * them. An uncertain one keeps its in-flight slot so a retry cannot pay twice; a
 * refused one holds none (its submit state is not an in-flight one, see
 * `inFlightProviderJobCondition`). Every parked status is a phantom one (below),
 * so none can count as generating.
 */
export const PARKED_SUBMIT_STATUSES = [
  'submit_unknown',
  'submit_rejected',
] as const satisfies readonly ProviderNormalizedStatus[];

/**
 * Phantom submit states NOTHING advances: `queued` (a submit that crashed
 * mid-call), `submit_unknown` (an uncertain paid submit, parked — terminal for
 * the automatic machine, see the map above) and `submit_rejected` (a definitive
 * refusal). Membership means exactly one thing: the job holds its buffer /
 * in-flight slot only while YOUNGER than the worker's
 * `PHANTOM_SUBMIT_MAX_AGE_MS`, so one dead submit cannot hold a slot forever
 * (a refusal's submit state keeps it out of the in-flight count at any age).
 *
 * Two related questions are answered elsewhere and do NOT follow from
 * membership here: whether the job counts as spend (its submit state decides,
 * `SPEND_SUBMIT_STATES`), and which block signal it surfaces to the listener
 * (the worker's `mapProviderBlockSignal` decides per status — a refused submit
 * reads as a provider error, an uncertain one as a stall).
 */
export const PHANTOM_SUBMIT_PROVIDER_STATUSES = [
  'queued',
  ...PARKED_SUBMIT_STATUSES,
] as const satisfies readonly ProviderNormalizedStatus[];

/**
 * How long a job parked in a phantom submit state (the bucket above) keeps
 * holding its buffer/in-flight slot. The hold is money safety — it stops a
 * Graphile retry of the SAME submit from double-paying — but the states are
 * otherwise dead ends, so past this bound the slot is released and the buffer
 * tops up with a NEW job (the parked job itself is never resubmitted). Shared by
 * the worker's buffer controller and every `countInFlightSessionJobs` caller
 * (the web app's session-delete guard included), so all in-flight views apply
 * the same bound. Spend counting (`countTasksInWindow`) is independent of this
 * bound: a parked job counts for its whole window, or never, by submit state.
 */
export const PHANTOM_SUBMIT_MAX_AGE_MS = 15 * 60_000;

/**
 * The instant a phantom submit stops holding its slot, for a given "now" — the
 * `phantomSubmitCutoff` every in-flight read takes. Derived in one place so the
 * buffer sweep, the concurrency denominator, the session-delete guard and the
 * queue poll cannot bound the hold differently.
 */
export function phantomSubmitCutoffAt(now: Date = new Date()): Date {
  return new Date(now.getTime() - PHANTOM_SUBMIT_MAX_AGE_MS);
}

/**
 * `tracks.status` (writers: worker jobs for provider/storage readiness; feedback
 * actions for rejection; owner API for explicit deletion).
 *
 * - `pending`    → `streamable` (stream URL ~40s) | `ready` (final downloaded
 *                  fast) | `rejected` (disliked before audio) | `deleted`
 *                  (owner deletion) | `failed`
 * - `streamable` → `ready` | `rejected` | `deleted` (owner deletion) | `failed`
 * - `ready`      → `rejected` (disliked) | `deleted` (cleanup or owner deletion)
 * - `rejected`   → `deleted` (reject window ~24h elapses; row + audio purged)
 * - `failed`     → `deleted` (cleanup of a failed track's partial assets)
 * - `deleted` is terminal; an evicted track is re-generated as a NEW track, never
 *   un-deleted.
 *
 * Writers: the worker writes readiness (`pending`→`streamable`→`ready`) and
 * cleanup transitions to `deleted`; feedback actions write `*→rejected`
 * (Dislike); the owner API writes explicit `*→deleted` transitions.
 */
export const TRACK_STATUS_TRANSITIONS: TransitionMap<TrackStatus> = {
  pending: ['streamable', 'ready', 'rejected', 'deleted', 'failed'],
  streamable: ['ready', 'rejected', 'deleted', 'failed'],
  ready: ['rejected', 'deleted'],
  rejected: ['deleted'],
  failed: ['deleted'],
  deleted: [],
};

/** The four state machines, keyed by their public contract name. */
export interface MachineStates {
  activitySessionStatus: ActivitySessionStatus;
  queueItemState: QueueItemState;
  providerNormalizedStatus: ProviderNormalizedStatus;
  trackStatus: TrackStatus;
}

/** A machine name. */
export type Machine = keyof MachineStates;

const TRANSITIONS: { [M in Machine]: TransitionMap<MachineStates[M]> } = {
  activitySessionStatus: ACTIVITY_SESSION_TRANSITIONS,
  queueItemState: QUEUE_ITEM_TRANSITIONS,
  providerNormalizedStatus: PROVIDER_NORMALIZED_TRANSITIONS,
  trackStatus: TRACK_STATUS_TRANSITIONS,
};

/**
 * The legal writers of each machine's column, as importable data (not just docs).
 *
 * Matches the transitions encoded above, including feedback removal and explicit owner deletion.
 */
export const STATE_MACHINE_WRITERS: Readonly<Record<Machine, readonly string[]>> = {
  activitySessionStatus: ['api-routes:user-intent', 'worker:terminal-cleanup', 'worker:idle-sweep'],
  queueItemState: [
    'buffer-controller',
    'playback-state-api',
    'feedback-actions:dislike-reject',
    'api-routes:owner-delete',
  ],
  providerNormalizedStatus: ['worker-jobs'],
  trackStatus: [
    'worker-jobs:provider-storage-readiness',
    'worker-jobs:cleanup-eviction',
    'feedback-actions:rejection',
    'api-routes:owner-delete',
  ],
};

/** The non-transition session fields tracked by `SESSION_FIELD_WRITERS`. */
type SessionFieldWriter = 'generationStatus' | 'sessionMode';

/**
 * Writers for the session FIELDS that are NOT transition graphs — `generationStatus`
 * and `sessionMode`. Generation/limit status stays a controller property
 * and never a lifecycle state, so neither belongs in the transition registry
 * (`STATE_MACHINE_WRITERS` is typed over the four TRANSITION machines only). This
 * sibling table records who may write each, so the writer rule stays importable
 * data rather than prose. The tokens are canonical — `'buffer-controller'` and
 * `'api-routes:user-intent'` are the SAME spellings used in `STATE_MACHINE_WRITERS`
 * so a single grep answers "who may write this column" across both maps:
 *
 *   - `generationStatus` — the `'buffer-controller'` ONLY (the worker-side
 *     generation controller; it observes cost limits, provider credits/rate-limits,
 *     stalls, and errors). An API route never sets it.
 *   - `sessionMode` — `'api-routes:user-intent'` ONLY (the voluntary-Repeat control;
 *     the worker merely *consumes* it to decide whether to top up the buffer).
 */
export const SESSION_FIELD_WRITERS: Readonly<Record<SessionFieldWriter, readonly string[]>> = {
  generationStatus: ['buffer-controller'],
  sessionMode: ['api-routes:user-intent'],
};

function transitionsFor<M extends Machine>(
  machine: M,
): Readonly<Record<string, readonly string[]>> {
  return TRANSITIONS[machine] as Readonly<Record<string, readonly string[]>>;
}

/**
 * True when `from → to` is a legal move for `machine`. A self-transition
 * (`from === to`) is never a legal transition — it is a no-op, not a move.
 */
export function canTransition<M extends Machine>(
  machine: M,
  from: MachineStates[M],
  to: MachineStates[M],
): boolean {
  return nextStates(machine, from).includes(to);
}

/** The legal next states for `from` in `machine` (empty for a terminal state). */
export function nextStates<M extends Machine>(
  machine: M,
  from: MachineStates[M],
): readonly MachineStates[M][] {
  return (transitionsFor(machine)[from] ?? []) as readonly MachineStates[M][];
}

/** True when `state` has no outgoing transitions in `machine`. */
export function isTerminalState<M extends Machine>(machine: M, state: MachineStates[M]): boolean {
  return nextStates(machine, state).length === 0;
}

/**
 * Assert that `from → to` is legal for `machine`; throws a descriptive error
 * otherwise. Use at every write site so an illegal move fails loudly instead of
 * silently corrupting state. NOTE: a self-transition (`from === to`) is treated as
 * illegal (it is a no-op, not a move) — guard `from !== to` at the call site if a
 * caller may re-write the current value.
 */
export function assertTransition<M extends Machine>(
  machine: M,
  from: MachineStates[M],
  to: MachineStates[M],
): void {
  if (!canTransition(machine, from, to)) {
    const allowed = nextStates(machine, from);
    const allowedText = allowed.length > 0 ? allowed.join(', ') : '(none — terminal)';
    throw new Error(
      `Illegal ${machine} transition: "${from}" → "${to}". Allowed from "${from}": ${allowedText}.`,
    );
  }
}

// --- Cross-machine session invariants ---------------------------------------

/** The status a prior active session takes when superseded (Start/More-Like-This/Resume). */
export const SUPERSEDED_SESSION_STATUS = 'stopped' satisfies ActivitySessionStatus;

/**
 * Invariant: at most one `active` session per user. Throws if `statuses`
 * (one user's sessions) contains more than one `active`.
 */
export function assertAtMostOneActiveSession(statuses: readonly ActivitySessionStatus[]): void {
  const active = statuses.filter((s) => s === 'active').length;
  if (active > 1) {
    throw new Error(
      `Invariant violated: ${active} active sessions for one user (at most one allowed).`,
    );
  }
}

/**
 * Both Change Vibe and Resume act on ONE existing session in place, so neither may
 * change its identity. Shared guard for that invariant; `action` names the caller
 * for the error message.
 */
function assertSameSessionIdentity(
  action: string,
  before: { id: string },
  after: { id: string },
): void {
  if (before.id !== after.id) {
    throw new Error(
      `${action} must keep the same Session identity (before=${before.id}, after=${after.id}).`,
    );
  }
}

/**
 * Change Vibe re-styles the CURRENT session in place: same identity,
 * same status (`active`), new Style Snapshot. It never creates a second session
 * and never moves the lifecycle. Throws if the id changed or the status is not
 * preserved as `active`.
 */
export function assertChangeVibePreservesSession(
  before: { id: string; status: ActivitySessionStatus },
  after: { id: string; status: ActivitySessionStatus },
): void {
  assertSameSessionIdentity('Change Vibe', before, after);
  if (before.status !== 'active' || after.status !== 'active') {
    throw new Error(
      `Change Vibe re-styles an active Session in place; status must stay "active" ` +
        `(before=${before.status}, after=${after.status}).`,
    );
  }
}

/**
 * Resume Session re-activates a Stopped session in place: same identity, lifecycle moves `stopped → active`. The mirror
 * of `assertChangeVibePreservesSession` for the one lifecycle move Resume makes —
 * unlike Change Vibe (which stays `active`), this one IS a transition, so it lives
 * with the transition helpers. Throws if the identity changed or the move is not
 * exactly `stopped → active`.
 */
export function assertResumeReactivates(
  before: { id: string; status: ActivitySessionStatus },
  after: { id: string; status: ActivitySessionStatus },
): void {
  assertSameSessionIdentity('Resume', before, after);
  if (before.status !== 'stopped' || after.status !== 'active') {
    throw new Error(
      `Resume re-activates a Stopped Session in place; status must move "stopped" → "active" ` +
        `(before=${before.status}, after=${after.status}).`,
    );
  }
}

/**
 * Resolve the active playback client after a `reportPlaybackState`. There is one
 * controller per active session and NO simultaneous multi-device playback, so
 * the latest reporting client always wins and becomes
 * `activePlaybackClientId`. `changed` is true when control moved to a different
 * device, which the server can use to tell the displaced client it lost control.
 */
export function resolveActivePlaybackClient(
  currentClientId: string | null,
  reportingClientId: string,
): { activeClientId: string; changed: boolean } {
  return { activeClientId: reportingClientId, changed: currentClientId !== reportingClientId };
}

/** All four machine names, for exhaustive iteration in tests/tooling. */
export const MACHINES = [
  'activitySessionStatus',
  'queueItemState',
  'providerNormalizedStatus',
  'trackStatus',
] as const satisfies readonly Machine[];

/** Every state of a machine, in declaration order (for completeness checks). */
export const MACHINE_STATES: { [M in Machine]: readonly MachineStates[M][] } = {
  activitySessionStatus: ACTIVITY_SESSION_STATUSES,
  queueItemState: QUEUE_ITEM_STATES,
  providerNormalizedStatus: PROVIDER_NORMALIZED_STATUSES,
  trackStatus: TRACK_STATUSES,
};
