// `ensure-session-buffer` — the buffer / generation controller. Runs per
// active session (serialized by `job_key=buffer:{sessionId}`): reads the session's
// buffer + budget + provider state, decides the action via the pure
// `decideBufferAction`, writes the resulting `generationStatus`, and performs the
// side effect:
//
//   - generate         → submit ONE new provider job (mock provider in tests; Suno
//                        in production), recorded as spend before the paid call.
//   - session_repeat   → cost limit: loop the session's own tracks (no spend); the
//                        session stays active and auto-resumes when the window rolls.
//   - voluntary_repeat → user Repeat mode: loop the session's own tracks, don't generate.
//   - wait / noop      → nothing this tick.
//
// `evaluateSubmitBudget` is the money chokepoint: the Admin is checked against
// the instance `usageLimits`, a Member against BOTH their `MemberLimits` and
// the shared `MembersPool`. Every window keys off the EXISTING
// usage-limit window (`resetTimezone`) — there is no second reset path.
//
// COST-CONTROL RACES — the limit/concurrency counts, the decision they feed, and
// the `submitting` row insert all run inside `withOwnerGenerationLock` (a per-owner
// advisory lock): per-session `job_key` serialization does not cover two sessions
// of the same owner (worker `concurrency: 2`), and without the lock both ticks
// could read `dailyUsed = cap − 1` (or `inFlight = 0`) and both submit. A Member
// submit additionally holds the Pool-wide lock (owner → Pool, fixed order),
// because two DIFFERENT Members hold different owner locks. The paid provider
// call runs AFTER the locks release — the committed `submitting` row is what the
// next tick's counts see.

import {
  checkCostLimits,
  memberBoundScope,
  truncateTrackDataPrompt,
  type BlendIdentity,
  type CostLimitDecision,
  type CostLimitWindow,
  type MemberCostLimitScope,
  type SessionGenerationStatus,
} from '@liedmotif/shared';
import {
  appendSessionTrackTitles,
  clearPendingRerolls,
  consumePendingReroll,
  countTaskBounds,
  getAdminDisplayName,
  getBufferSessionCounts,
  getCredentialUpdatedAt,
  getGenerationSettings,
  getLatestProviderJobState,
  getReadyVoiceProfile,
  getRecentLyricBriefs,
  hasPlayableSessionTrack,
  getSessionForBuffer,
  getSessionDurationProgress,
  getStorageUsage,
  getUsageLimits,
  hasLiveLoopLease,
  insertSubmittingGenerationJob,
  isStorageQuotaReached,
  lockAndResolveBudgetScopes,
  listSessionLoopCandidates,
  MAX_TRACK_AUDIO_BYTES,
  lockSessionForBuffer,
  markProviderJobSubmitted,
  mapScopeResults,
  parkUnsubmittedProviderJob,
  peekPendingRerollIdentity,
  readEnvLayer,
  recordProviderTaskIdFailSafe,
  recordUsageEvent,
  setGenerationStatus,
  touchVoiceProfileUsed,
  updateRequestStyleSnapshot,
  withOwnerGenerationLock,
  type Database,
  type RerollIdentity,
  type StyleSnapshot,
  type Transaction,
  type UsageLimits,
  type UserRole,
} from '@liedmotif/db';
import {
  buildSessionStyle,
  compileMusicGenerationInput,
  compileRerollInput,
  MAX_TRACK_TITLE_POOL,
  ProviderUnbilledError,
  sessionStyleSnapshotSchema,
  trackTitleRefillCount,
  type CompileMusicInputOptions,
  type MusicGenerationInput,
  type MusicGenerationTask,
  type LlmProvider,
  type MusicProvider,
  type SessionStyleSnapshot,
} from '@liedmotif/providers';
import type { Task } from 'graphile-worker';
import {
  decideBufferAction,
  isFailedPaidBatch,
  isListenerActive,
  mapProviderBlockSignal,
  restartCountsAsListener,
  phantomSubmitCutoffAt,
  type BufferAction,
  type BufferDecisionInput,
  type GenerationBlockSignal,
} from '../controller/buffer';
import {
  safeStatusMessage,
  submitBlockMessage,
  PROVIDER_UNAVAILABLE_MESSAGES,
  TERMINAL_BLOCK_MESSAGES,
  type SubmitBlockReason,
} from './cost-limit-copy';
import { enqueuePollAt } from './enqueue';

/** A provider job making no progress for this long reads as `worker_stalled`. */
export const DEFAULT_STALL_THRESHOLD_MS = 5 * 60_000;

/**
 * Delay before the FIRST status poll of a freshly-submitted job — Suno's stream URL
 * appears ~30-40s in, so the first poll is timed just before that. Subsequent polls
 * self-reschedule on a tighter interval.
 */
export const FIRST_POLL_DELAY_MS = 25_000;

export interface EnsureSessionBufferDeps {
  db: Database;
  music: MusicProvider;
  limits: UsageLimits;
  now?: Date;
  stallThresholdMs?: number;
  /**
   * Schedule the FIRST status poll for a freshly-submitted provider job.
   * Called only AFTER the paid submit is durably recorded with its task id, so a
   * parked/uncertain submit never starts a poll loop. Polls then self-reschedule.
   */
  enqueuePoll?: (providerJobId: string) => Promise<void>;
  /**
   * When this worker process started. An env-supplied key or base URL is never
   * dated by a stored row, and applying an env change requires a restart, so
   * the process boundary is its config revision. Omitted means "no restart to
   * account for" — a definitive refusal then lifts only on the other triggers.
   */
  workerStartedAt?: Date;
  /** Diagnostics sink (Graphile's logger in production, console in tests). */
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * Resolve the configured text LLM, or `null` when unconfigured — the text
   * LLM is optional, so omitting the dep means "no LLM" and every
   * LLM-backed nicety degrades rather than blocking generation.
   */
  getLlm?: () => Promise<LlmProvider | null>;
}

export interface EnsureSessionBufferPayload {
  sessionId: string;
}

export interface EnsureSessionBufferResult {
  action: BufferAction;
  generationStatus: SessionGenerationStatus;
  /** Which bound refused (`repeat_cost_limit` for a Member): personal or Pool. */
  costLimitScope?: MemberCostLimitScope;
  /** Which window of that bound: a rolling `day`/`month`, or a One-time `total`. */
  costLimitWindow?: CostLimitWindow;
  /** Set when a new provider job was submitted (action `generate`). */
  submittedTaskId?: string;
  /** The submitted provider job's id (the poll loop's subject), when one was submitted. */
  submittedProviderJobId?: string;
  /** The session's own tracks to loop (action `session_repeat`/`voluntary_repeat`). */
  loopTrackIds?: string[];
}

/**
 * Whether anything that could change a definitive refusal's outcome happened
 * after it was recorded. A refusal costs nothing, so the cost limits that bound
 * every other retry never engage — it stays terminal until the provider config
 * changes or the listener explicitly restarts the session (Resume, which already
 * clears the stored generation status). Change Vibe is not checked here: it
 * changes the compiled style, which the style comparison already sees.
 */
async function hasRefusalContextChanged(
  tx: Transaction,
  args: {
    refusedAt: Date;
    lastResumedAt: Date | null;
    workerStartedAt: Date | null;
    providerKey: string;
  },
): Promise<boolean> {
  const refusedAtMs = args.refusedAt.getTime();
  if ((args.lastResumedAt?.getTime() ?? 0) > refusedAtMs) return true;
  const credentialUpdatedAt = await getCredentialUpdatedAt(tx, {
    providerType: 'music',
    providerKey: args.providerKey,
  });
  // A stored credential dates itself. An env-supplied key or base URL only
  // takes effect across a restart, so the worker's own start is ITS revision —
  // a stored row beside it is only the fallback and dates app saves alone. On
  // an instance whose credential is stored and the env supplies nothing, a
  // deploy says nothing about the provider and must not re-open a refused
  // Session.
  const envSupplied = Object.keys(readEnvLayer('music', args.providerKey)).length > 0;
  const restartAt = envSupplied || credentialUpdatedAt == null ? args.workerStartedAt : null;
  const configRevisionAt = Math.max(credentialUpdatedAt?.getTime() ?? 0, restartAt?.getTime() ?? 0);
  return configRevisionAt > refusedAtMs;
}

/**
 * What one `generate` would submit: the provider input plus everything the
 * request row records about it (style identity, blend identity, compilation
 * context, and — for a reroll — the intent it consumes).
 */
interface SubmitPlan {
  input: MusicGenerationInput;
  /** The request's stored style identity (the policy-block reference). */
  stylePrompt: string | null;
  identity: BlendIdentity;
  styleSnapshot: StyleSnapshot | null;
  /** The prompt history this request freezes (Track Data's "Your prompt"). */
  userPrompt: string | null;
  /**
   * The snapshot asks for the user's own voice: the submit must carry a
   * resolved provider voice reference or be BLOCKED — never silently fall back
   * to generic vocals (a paid track in the wrong voice is unrecoverable).
   */
  useOwnVoice: boolean;
  /** Set when this plan consumes a pending reroll intent. */
  rerollTrackId?: string;
  /**
   * The validated LIVE snapshot a FRESH submit compiled from — the track-lyric-
   * brief injection's compilation context. Deliberately absent on every reroll
   * plan: a reroll's frozen snapshot already carries its own brief and must
   * never trigger a text-LLM call.
   */
  freshSnapshot?: SessionStyleSnapshot;
}

/**
 * PLAN what a generate would submit. Pure — the tick computes it BEFORE the
 * provider-block check, because the block comparison must test the style that
 * would actually go out. A pending Dislike reroll takes precedence over the
 * live snapshot: its replacement is submitted with the DISLIKED TRACK's request
 * identity + compilation context, never re-derived from the live snapshot. The
 * tick cancels a reroll whose vibe a Change Vibe replaced before planning, so
 * the pending one shares the live revision.
 * Sources, best first:
 *
 *   1. the original request's persisted snapshot → THE SAME compiler with a
 *      fresh index (the same prompt, hidden-seed variation rotated);
 *   2. the stored style / track prompt through the degraded legacy input (old
 *      vibe kept; seed/vocal context unrecoverable on older rows);
 *   3. nothing recoverable → the live snapshot, stamped
 *      with the CURRENT identity — the revision read from the same locked row
 *      as the snapshot it compiles, and the snapshot's frozen BPM/key.
 *
 * The compile index is the count of generation requests the session has EVER
 * created: monotonic (ready-track counts are not — dislikes and eviction shrink
 * them), so no submit can re-derive an earlier track's hidden seed, and a fresh
 * reroll after rejected siblings never resubmits a byte-identical request. The
 * provider caps budget the description so its variation/BPM/key tail survives
 * the adapter's boundary clamp.
 *
 * The prompt provenance follows the same rule as the style: a fresh submit
 * FREEZES the session's prompt history as it stands, a reroll copies the
 * original request's frozen value — the replacement tells the story of the
 * Track it replaces.
 */
function planSubmit(args: {
  reroll: RerollIdentity | null;
  /** The session's LIVE snapshot (`fresh.snapshot`, read under the row lock). */
  liveSnapshot: unknown;
  /** The session's LIVE prompt history (same locked row). */
  sessionUserPrompt: string | null;
  /** The live snapshot's revision (same locked row). */
  styleRevision: number;
  /** The monotonic per-session compile index (`priorSessionRequests`). */
  requestIndex: number;
  providerCaps: CompileMusicInputOptions;
}): SubmitPlan | null {
  const { reroll, requestIndex, providerCaps } = args;
  const rerollSnapshot = reroll?.styleSnapshot
    ? sessionStyleSnapshotSchema.safeParse(reroll.styleSnapshot)
    : null;
  if (reroll && rerollSnapshot?.success) {
    return {
      input: compileMusicGenerationInput(rerollSnapshot.data, requestIndex, providerCaps),
      stylePrompt: reroll.stylePrompt ?? buildSessionStyle(rerollSnapshot.data),
      identity: reroll,
      styleSnapshot: reroll.styleSnapshot,
      userPrompt: reroll.userPrompt,
      useOwnVoice: rerollSnapshot.data.useOwnVoice,
      rerollTrackId: reroll.trackId,
    };
  }
  const rerollStyle = reroll ? (reroll.stylePrompt ?? (reroll.prompt || null)) : null;
  if (reroll && rerollStyle != null) {
    return {
      input: compileRerollInput({ ...reroll, stylePrompt: rerollStyle }, providerCaps),
      stylePrompt: rerollStyle,
      identity: reroll,
      styleSnapshot: null,
      userPrompt: reroll.userPrompt,
      // Pre-snapshot legacy rows predate the own-voice feature entirely.
      useOwnVoice: false,
      rerollTrackId: reroll.trackId,
    };
  }
  const parsedSnapshot = sessionStyleSnapshotSchema.safeParse(args.liveSnapshot ?? {});
  if (!parsedSnapshot.success) return null;
  return {
    input: compileMusicGenerationInput(parsedSnapshot.data, requestIndex, providerCaps),
    stylePrompt: buildSessionStyle(parsedSnapshot.data),
    identity: {
      styleRevision: args.styleRevision,
      targetBpm: parsedSnapshot.data.bpm ?? null,
      targetKey: parsedSnapshot.data.key || null,
    },
    // The validated snapshot IS the stored shape; the cast only bridges the
    // providers-side interface to the db column's permissive jsonb type.
    styleSnapshot: parsedSnapshot.data as StyleSnapshot,
    userPrompt: truncateTrackDataPrompt(args.sessionUserPrompt),
    useOwnVoice: parsedSnapshot.data.useOwnVoice,
    freshSnapshot: parsedSnapshot.data,
  };
}

/** The reroll needs the user's voice, none can sing it, and the live snapshot no longer asks for it. */
async function isStrandedOwnVoiceReroll(
  tx: Transaction,
  args: {
    reroll: RerollIdentity;
    liveSnapshot: unknown;
    ownerUserId: string;
    customVoiceSupported: boolean;
  },
): Promise<boolean> {
  const rerollSnapshot = sessionStyleSnapshotSchema.safeParse(args.reroll.styleSnapshot ?? {});
  if (!rerollSnapshot.success || !rerollSnapshot.data.useOwnVoice) return false;
  const live = sessionStyleSnapshotSchema.safeParse(args.liveSnapshot ?? {});
  if (live.success && live.data.useOwnVoice) return false;
  if (!args.customVoiceSupported) return true;
  return (await getReadyVoiceProfile(tx, args.ownerUserId)) == null;
}

/** Every bound that gates a paid submit, counted and checked in one place. */
interface SubmitBudget {
  costLimit: CostLimitDecision;
  hasConcurrencySlot: boolean;
  /** The requester's queue-depth ceiling — the instance value for the Admin, their own for a Member. */
  maxQueuedTracks: number;
  /** Who owns the tick, so a block's copy names a fix the reader can make. */
  role: UserRole;
}

/**
 * Count spend and concurrency once per budget scope, then check them. Which
 * scopes apply is `budget-scopes`' answer, not this function's: the Admin has the
 * instance bound alone, a Member has their own budget and the Pool,
 * and resolving a Member additionally takes the Pool-wide lock — always AFTER the
 * caller's per-owner lock (fixed order, see `acquireMembersPoolLock`), because
 * two different Members hold different owner locks and would otherwise both pass
 * a Pool check. `null` means the owner was disabled mid-flight and must not spend
 * at all, whatever their session cookie still says.
 *
 * Sequential awaits on purpose: the lock transaction is one connection. Every
 * count (spend per window + in-flight, per scope) comes back from ONE
 * statement, so the lock hold pays one round trip.
 */
async function evaluateSubmitBudget(
  tx: Transaction,
  args: {
    ownerUserId: string;
    instanceLimits: UsageLimits;
    now: Date;
    phantomSubmitCutoff: Date;
  },
): Promise<SubmitBudget | null> {
  const budget = await lockAndResolveBudgetScopes(tx, {
    ownerUserId: args.ownerUserId,
    instanceLimits: args.instanceLimits,
  });
  if (budget.disabled) return null;

  const counted = await countTaskBounds(tx, {
    scopes: budget.scopes,
    now: args.now,
    resetTimezone: args.instanceLimits.resetTimezone,
    phantomSubmitCutoff: args.phantomSubmitCutoff,
  });
  return {
    costLimit: checkCostLimits(mapScopeResults(counted, (scope) => scope.bound)),
    hasConcurrencySlot: counted.every((scope) => scope.inFlightTasks < scope.maxConcurrentJobs),
    maxQueuedTracks: budget.maxQueuedTracks,
    role: budget.role,
  };
}

export async function runEnsureSessionBuffer(
  deps: EnsureSessionBufferDeps,
  payload: EnsureSessionBufferPayload,
): Promise<EnsureSessionBufferResult> {
  const now = deps.now ?? new Date();
  const stallThresholdMs = deps.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const session = await getSessionForBuffer(deps.db, payload.sessionId);

  // Stopped sessions are excluded from buffer work (the sweep never enqueues them,
  // but guard here too — a session can stop between enqueue and run).
  if (!session || session.status !== 'active') {
    return { action: 'noop', generationStatus: session?.generationStatus ?? 'ok' };
  }

  const { ownerUserId } = session;
  const phantomSubmitCutoff = phantomSubmitCutoffAt(now);

  // Count → check → insert is one mutually-exclusive sequence per owner (cost
  // controls are non-bypassable): the lock transaction holds the counts stable
  // against a concurrent tick of another session of the same owner, and the
  // `submitting` row (intent-to-spend) commits before the lock releases, so the
  // loser's counts include it. Only the paid provider call happens outside.
  const planned = await withOwnerGenerationLock(deps.db, ownerUserId, async (tx) => {
    // The pre-lock session read can be stale by the time the lock is acquired:
    // while a tick waits here, a session hop can stop THIS session, a Change
    // Vibe can replace its Style Snapshot, or the user can switch it to Repeat —
    // and every one of those fields feeds the paid decision. Re-read the WHOLE
    // buffer session under a row lock and decide/compile from THIS row only: a
    // stopped session must never insert an intent-to-spend row, and a submit
    // must never carry a snapshot/mode the user already moved away from.
    const fresh = await lockSessionForBuffer(tx, payload.sessionId);
    if (!fresh || fresh.status !== 'active') {
      return null;
    }

    // Role + disabled state are re-resolved UNDER the lock (inside
    // `evaluateSubmitBudget`): a user disabled mid-flight must not spend,
    // whatever their session cookie still says, and no status is written — the
    // session simply stops generating. An owner without a profile row follows
    // the instance-owner path: only a `member` row opts into the Pool bounds,
    // and a profile-less user cannot reach the app to create demand in the
    // first place (the API guards refuse them).
    //
    // Sequential on purpose: the lock transaction is ONE connection, and
    // node-postgres's implicit per-client query queuing (what Promise.all would
    // lean on here) is deprecated and removed in pg@9.
    const budget = await evaluateSubmitBudget(tx, {
      ownerUserId,
      instanceLimits: deps.limits,
      now,
      phantomSubmitCutoff,
    });
    if (!budget) {
      return null;
    }
    // An armed switch-now Change Vibe scopes Queue supply to the new revision:
    // old-revision ready/in-flight material will be set aside at cutover, so it
    // must not satisfy the new vibe's watermark. Owner-wide concurrency
    // (`countInFlightTasks`) stays unfiltered because old-vibe work still spends.
    // The compile index stays unscoped and monotonic. The current-revision
    // count gives every Style Snapshot revision exactly one initial fill without
    // changing the Queue supply scope used for play-out. Generation history
    // leaves out unbilled refusals: a refused fill bought nothing, so once its
    // cooldown clears the fill is still owed — in Repeat it is the revision's
    // only batch. All six counts arrive from one statement — one
    // lock-held round trip.
    const {
      readyAhead,
      ownReady,
      inFlightJobs: inFlightSessionJobs,
      totalRequests: priorSessionRequests,
      unrefusedRequests,
      currentRevisionUnrefusedRequests,
    } = await getBufferSessionCounts(tx, {
      sessionId: payload.sessionId,
      phantomSubmitCutoff,
      supplyAtOrAboveStyleRevision: fresh.vibeSwitchRevision ?? undefined,
      requestsAtOrAboveStyleRevision: fresh.styleRevision === 1 ? undefined : fresh.styleRevision,
    });
    const latestJob = await getLatestProviderJobState(tx, payload.sessionId);
    // The owner's Buffer settings, read live each tick so a change applies to
    // the running session within one sweep.
    const generationSettings = await getGenerationSettings(tx, fresh.ownerUserId);
    // The repeat-one hold: read inside the lock so the decision and
    // the intent-to-spend insert see one consistent lease state. An acquire
    // COMMITTING after this read but before this tick's submit is tolerated by
    // design — prefill stops within one sweep tick of an acknowledged hold
    // and an in-flight job may complete — so lease writes deliberately do NOT serialize against the sweep.
    const loopHeld = await hasLiveLoopLease(tx, { sessionId: payload.sessionId, now });

    // Each in-flight provider job yields ~`typicalTracksPerRequest` tracks; counting
    // that toward the buffer keeps a second sweep (or a retried submit) from issuing a
    // duplicate paid job before the first job's tracks are ready.
    const capabilities = deps.music.getCapabilities();
    const inFlightAhead = inFlightSessionJobs * capabilities.typicalTracksPerRequest;

    // CANCEL the pending fresh-call reroll intents the Session can no longer
    // honor rather than letting them sit: every one in Repeat ("stop
    // generating", not "defer"), and in Keep Going those of a vibe a Change
    // Vibe replaced (old-vibe rerolls buy nothing). This is the ONE
    // cancellation point, and it must run BEFORE the plan, because the planner
    // is reroll-first: a lingering intent would hijack the next legitimate
    // generate (a Change Vibe revision fill would submit the OLD vibe).
    await clearPendingRerolls(
      tx,
      payload.sessionId,
      fresh.sessionMode === 'repeat' ? {} : { belowStyleRevision: fresh.styleRevision },
    );

    // What a generate would submit this tick (reroll-first — see `planSubmit`).
    // The reroll intent is PEEKED here and consumed only when a submit really
    // happens, so a blocked/waiting tick leaves it pending for the next one.
    let reroll = await peekPendingRerollIdentity(tx, payload.sessionId);
    // An own-voice reroll with no voice to sing it blocks every tick, and the
    // reroll-first planner would serve it ahead of a live snapshot that no
    // longer asks for the user's voice — the Change Vibe the block copy
    // advises. Drop that intent so the live fill can generate.
    if (
      reroll &&
      (await isStrandedOwnVoiceReroll(tx, {
        reroll,
        liveSnapshot: fresh.snapshot,
        ownerUserId,
        customVoiceSupported: capabilities.customVoice?.supported === true,
      }))
    ) {
      await consumePendingReroll(tx, reroll.trackId);
      reroll = null;
    }
    const providerCaps: CompileMusicInputOptions = {
      maxStyleLength: capabilities.maxStyleLength,
      maxPromptLength: capabilities.maxPromptLength,
      maxOwnVoiceStyleLength: capabilities.customVoice?.maxStyleLength,
    };
    const livePlanArgs = {
      liveSnapshot: fresh.snapshot,
      sessionUserPrompt: fresh.userPrompt,
      styleRevision: fresh.styleRevision,
      requestIndex: priorSessionRequests,
      providerCaps,
    };
    let plan = planSubmit({ ...livePlanArgs, reroll });
    // A policy block never decays on a clock, so a reroll of the blocked style
    // can never be submitted — yet the reroll-first planner would serve it ahead
    // of the Change Vibe that lifted the block for the live style. Drop that
    // intent so the new vibe can generate.
    if (
      plan?.rerollTrackId &&
      latestJob?.normalizedStatus === 'blocked_by_policy' &&
      latestJob.stylePrompt != null &&
      plan.stylePrompt === latestJob.stylePrompt
    ) {
      const livePlan = planSubmit({ ...livePlanArgs, reroll: null });
      if (livePlan?.stylePrompt != null && livePlan.stylePrompt !== latestJob.stylePrompt) {
        await consumePendingReroll(tx, plan.rerollTrackId);
        reroll = null;
        plan = livePlan;
      }
    }

    let providerSignal: GenerationBlockSignal | null = null;
    // Try again and Resume record the listener's restart on the Session.
    const listenerRestartedSinceLatestJob =
      latestJob !== null && (fresh.lastResumedAt?.getTime() ?? 0) > latestJob.updatedAt.getTime();
    if (latestJob) {
      // Only a definitive refusal consults the re-open triggers, so the extra
      // read stays on the rare blocked tick instead of every sweep.
      const refusalContextChanged =
        latestJob.normalizedStatus === 'submit_rejected' &&
        (await hasRefusalContextChanged(tx, {
          refusedAt: latestJob.updatedAt,
          lastResumedAt: fresh.lastResumedAt,
          workerStartedAt: deps.workerStartedAt ?? null,
          providerKey: deps.music.providerKey,
        }));
      providerSignal = mapProviderBlockSignal({
        normalizedStatus: latestJob.normalizedStatus,
        ageMs: now.getTime() - latestJob.updatedAt.getTime(),
        stallThresholdMs,
        refusalContextChanged,
        listenerRestartedSince: listenerRestartedSinceLatestJob,
        // Compare the blocked style against the style THIS tick would submit —
        // a pending reroll must stay blocked when ITS style is the blocked one,
        // and a reroll of a different, safe style may proceed while the live
        // style is blocked. Unknown on either side blocks too — fail closed
        // against a retry storm.
        blockedStyleUnchanged:
          latestJob.stylePrompt == null ||
          plan?.stylePrompt == null ||
          latestJob.stylePrompt === plan.stylePrompt,
      });
      if (providerSignal === 'provider_error' && isMaintenanceWait(latestJob)) {
        providerSignal = 'provider_rate_limited';
      }
    }

    const hasPlayableTrack = () =>
      hasPlayableSessionTrack(tx, { ownerUserId, sessionId: payload.sessionId });
    // Only a failed paid batch with nothing in flight consults the playable
    // Tracks, so the extra read stays on the rare stuck-candidate tick.
    const stuck =
      latestJob !== null &&
      isFailedPaidBatch(latestJob) &&
      inFlightSessionJobs === 0 &&
      !(await hasPlayableTrack());
    // Paid top-ups only while someone is listening (or right after a restart,
    // so the cold-start prefill still runs before the first play). A Resume or
    // Try again whose batch is in flight before anything plays waits for that
    // audio; the playable read runs only on a tick where the restart alone is
    // the listener.
    const listenerActive =
      isListenerActive(fresh, now) &&
      (isListenerActive(fresh, now, { restartsCount: false }) ||
        restartCountsAsListener({
          resumed: fresh.lastResumedAt !== null,
          inFlightJobs: inFlightSessionJobs,
          hasPlayableTrack: inFlightSessionJobs > 0 && (await hasPlayableTrack()),
        }));

    let duration: BufferDecisionInput['duration'];
    if (fresh.targetDurationMinutes != null) {
      const progress = await getSessionDurationProgress(tx, {
        ownerUserId,
        sessionId: fresh.sessionId,
        phantomSubmitCutoff,
      });
      duration = {
        targetMinutes: fresh.targetDurationMinutes,
        generatedSeconds: progress.generatedDurationSeconds,
        unknownTrackCount: progress.unknownDurationTrackCount,
        batchOutstanding: progress.batchOutstanding,
      };
    }
    const decision = decideBufferAction({
      duration,
      sessionMode: fresh.sessionMode,
      readyAheadCount: readyAhead,
      inFlightAheadCount: inFlightAhead,
      bufferAheadTracks: generationSettings.bufferAheadTracks,
      maxQueuedTracks: budget.maxQueuedTracks,
      hasEverGenerated: unrefusedRequests > 0,
      hasCurrentRevisionGenerated: currentRevisionUnrefusedRequests > 0,
      rerollPending: reroll !== null,
      ownReadyTrackCount: ownReady,
      manualGenerationOnly: deps.limits.manualGenerationOnly,
      hasConcurrencySlot: budget.hasConcurrencySlot,
      costLimit: budget.costLimit,
      providerSignal,
      listenerActive,
      loopHeld,
      stuck,
      retryRequested: stuck && listenerRestartedSinceLatestJob,
    });

    /** Leave the lock having decided against the submit — nothing bought, nothing recorded. */
    const blockSubmit = (reason: SubmitBlockReason) => ({
      decision,
      blockMessage: null,
      submitInput: null,
      submitting: undefined,
      submitBlockedMessage: submitBlockMessage(reason, budget.role),
      trackLyricBrief: null,
      titleRefill: null,
    });

    // Record the intent-to-spend before the lock releases: the `submitting` row is
    // counted by the spend + in-flight queries above, so a concurrent tick that
    // enters the lock next sees the slot/budget already taken.
    let submitting: PaidSubmitContext | undefined;
    let submitInput: MusicGenerationInput | null = null;
    let trackLyricBrief: TrackLyricBriefContext | null = null;
    let titleRefill: TitleRefillContext | null = null;
    if (decision.action === 'generate' && plan) {
      // Every generated track lands as stored bytes, so the storage quota is an
      // admission gate like the budget: refuse BEFORE the intent-to-spend row,
      // never after paying for audio there is no room to keep. "Room" is what
      // the call's final downloads will each reserve — a gate that admits less
      // buys tracks whose download the quota then refuses. The total is the
      // periodically measured one — an admission decision does not re-measure.
      const finalBytes = capabilities.typicalTracksPerRequest * MAX_TRACK_AUDIO_BYTES;
      if (
        isStorageQuotaReached(await getStorageUsage(tx), deps.limits.storageQuotaBytes, finalBytes)
      ) {
        return blockSubmit('storage_quota');
      }
      // A snapshot that asks for the user's own voice must resolve to a READY
      // provider voice reference before any spend; otherwise the tick BLOCKS
      // (status + safe message by the caller) rather than falling back to
      // generic vocals. Resolved under the lock so the profile read and the
      // intent-to-spend insert see one consistent state.
      let customVoice: MusicGenerationInput['customVoice'];
      if (plan.useOwnVoice) {
        const voiceRef = capabilities.customVoice?.supported
          ? await getReadyVoiceProfile(tx, fresh.ownerUserId)
          : null;
        if (!voiceRef) return blockSubmit('own_voice');
        customVoice = { providerVoiceId: voiceRef.providerVoiceId };
      }
      // The submit is really happening — consume the reroll intent it serves.
      if (plan.rerollTrackId) await consumePendingReroll(tx, plan.rerollTrackId);
      submitInput = customVoice ? { ...plan.input, customVoice } : plan.input;
      const { jobId, requestId } = await insertSubmittingGenerationJob(tx, {
        ownerUserId: fresh.ownerUserId,
        activitySessionId: fresh.sessionId,
        providerKey: deps.music.providerKey,
        // Stored as the request's style identity (and the future policy-block
        // reference), so it is the SESSION style — not the per-track variant.
        ...(plan.stylePrompt != null ? { stylePrompt: plan.stylePrompt } : {}),
        // The request's index within the session, recorded so materialization can
        // title this call's sibling tracks distinctly (per-track ordinal =
        // index * requestedTrackCount + k). A reroll still gets a FRESH index so
        // sibling titles stay distinct across the session's calls.
        titleSeed: priorSessionRequests,
        // The ordinal multiplier materialization names siblings by — the same
        // count the title-refill gate plans with.
        requestedTrackCount: capabilities.typicalTracksPerRequest,
        identity: plan.identity,
        styleSnapshot: plan.styleSnapshot,
        negativePrompt: plan.input.negativeTags ?? null,
        userPrompt: plan.userPrompt,
      });
      submitting = { jobId, requestId, ownerUserId: fresh.ownerUserId };
      // Whether THIS committed intent qualifies for a track lyric brief:
      // a FRESH vocal submit with lyric notes — never a reroll
      // (its frozen snapshot already carries its own brief). Only the gate is
      // decided here; the LLM round trip itself runs after the lock releases.
      if (
        !plan.rerollTrackId &&
        plan.freshSnapshot &&
        plan.freshSnapshot.vocalMode === 'vocal' &&
        plan.freshSnapshot.lyricContext
      ) {
        trackLyricBrief = {
          snapshot: plan.freshSnapshot,
          requestIndex: priorSessionRequests,
          providerCaps,
          userPrompt: plan.userPrompt,
        };
      }
      // Decided here, run after the lock like the brief. Titles are
      // Session-wide, not part of the vibe, so the gate reads the LIVE pool for
      // a reroll too: its fresh ordinals are named from the Session's pool.
      const live = sessionStyleSnapshotSchema.safeParse(fresh.snapshot ?? {});
      if (live.success) {
        const count = trackTitleRefillCount(
          live.data.trackTitles.length,
          priorSessionRequests,
          capabilities.typicalTracksPerRequest,
        );
        if (count > 0) titleRefill = { snapshot: live.data, count, userPrompt: plan.userPrompt };
      }
    }

    const blockingStatus = latestJob?.normalizedStatus;
    let blockMessage: string | null = null;
    if (
      decision.generationStatus === 'provider_error' &&
      (blockingStatus === 'blocked_by_policy' || blockingStatus === 'submit_rejected')
    ) {
      blockMessage = TERMINAL_BLOCK_MESSAGES[blockingStatus];
    } else if (
      decision.generationStatus === 'provider_rate_limited' &&
      isMaintenanceWait(latestJob)
    ) {
      // Maintenance shares the backoff status with rate limits; its own copy
      // names the cause.
      blockMessage = PROVIDER_UNAVAILABLE_MESSAGES[ownReady === 0 ? 'noTracks' : 'playing'];
    }
    return {
      decision,
      blockMessage,
      submitInput,
      submitting,
      submitBlockedMessage: null,
      trackLyricBrief,
      titleRefill,
    };
  });

  // Stopped mid-hop while this tick waited at the lock — mirror the pre-check:
  // no status write, no spend, nothing to do.
  if (!planned) {
    return { action: 'noop', generationStatus: session.generationStatus };
  }

  const {
    decision,
    blockMessage,
    submitInput,
    submitting,
    submitBlockedMessage,
    trackLyricBrief,
    titleRefill,
  } = planned;

  // A pre-spend block: nothing was bought, the session keeps playing what it
  // has, and the copy names what the reader can actually do about it.
  if (submitBlockedMessage) {
    await setGenerationStatus(deps.db, {
      sessionId: payload.sessionId,
      status: 'provider_error',
      statusMessageSafe: submitBlockedMessage,
    });
    return { action: 'wait', generationStatus: 'provider_error' };
  }

  // The stored scope is the Member half of the bound vocabulary: the Admin's own
  // instance bound records `null`, because "which of your budgets" is not a
  // question their refusal copy asks.
  const storedScope = decision.costLimitScope ? memberBoundScope(decision.costLimitScope) : null;
  const costLimit = { scope: storedScope, window: decision.costLimitWindow ?? null };
  // Only a used-up One-time budget names a person: the Admin is the only one who
  // can raise a total, and every other stop waits on a clock instead.
  const adminName = costLimit.window === 'total' ? await getAdminDisplayName(deps.db) : null;

  await setGenerationStatus(deps.db, {
    sessionId: payload.sessionId,
    status: decision.generationStatus,
    scope: storedScope,
    statusMessageSafe:
      blockMessage ??
      decision.statusMessageSafe ??
      safeStatusMessage(decision.generationStatus, costLimit, adminName),
  });

  const result: EnsureSessionBufferResult = {
    action: decision.action,
    generationStatus: decision.generationStatus,
    ...(storedScope ? { costLimitScope: storedScope } : {}),
    ...(decision.costLimitWindow ? { costLimitWindow: decision.costLimitWindow } : {}),
  };

  if (submitting && submitInput) {
    // The per-generation text-LLM calls: between the
    // committed intent-to-spend and the paid POST — never under the owner lock —
    // and strictly best-effort: a failure never blocks the submit.
    if (titleRefill) await refillTrackTitles(deps, payload.sessionId, titleRefill);
    const input = trackLyricBrief
      ? await applyTrackLyricBrief(deps, {
          sessionId: payload.sessionId,
          requestId: submitting.requestId,
          staticInput: submitInput,
          context: trackLyricBrief,
        })
      : submitInput;
    const submitted = await performPaidSubmit(deps, submitting, input);
    result.submittedTaskId = submitted.taskId;
    result.submittedProviderJobId = submitting.jobId;
    // Kick off the status poll loop now that the paid submit is durably recorded.
    await deps.enqueuePoll?.(submitting.jobId);
    if (input.customVoice) {
      // Best-effort usage stamp (diagnostics) — never fails a paid submit.
      try {
        await touchVoiceProfileUsed(deps.db, { ownerUserId: submitting.ownerUserId });
      } catch (err) {
        deps.warn?.('voice-profile usage stamp failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else if (decision.action === 'session_repeat' || decision.action === 'voluntary_repeat') {
    result.loopTrackIds = await listSessionLoopCandidates(deps.db, payload.sessionId);
  }

  return result;
}

/** What the post-lock title refill needs: the Session's live snapshot and the ask. */
interface TitleRefillContext {
  snapshot: SessionStyleSnapshot;
  count: number;
  userPrompt: string | null;
}

/**
 * The track-title pool refill: one bounded
 * text-LLM call for fresh titles when this submit's sibling ordinals would run
 * past the Session's pool, appended to the Session's LIVE pool before the paid
 * POST — materialization names the submit's Tracks from that pool. Best-effort:
 * on any failure the Tracks fall back to a numbered repeat of a pool title.
 */
async function refillTrackTitles(
  deps: EnsureSessionBufferDeps,
  sessionId: string,
  context: TitleRefillContext,
): Promise<void> {
  try {
    const llm = await deps.getLlm?.();
    if (!llm) return;
    const titles = await llm.createTrackTitles({
      takenTitles: context.snapshot.trackTitles,
      count: context.count,
      stylePrompt: context.snapshot.stylePrompt,
      mood: context.snapshot.mood,
      language: context.snapshot.language,
      ...(context.userPrompt ? { userPrompt: context.userPrompt } : {}),
    });
    if (titles.length === 0) {
      deps.warn?.('track title refill unavailable; titles will repeat with a number', {
        sessionId,
      });
      return;
    }
    await appendSessionTrackTitles(deps.db, {
      sessionId,
      titles,
      maxPool: MAX_TRACK_TITLE_POOL,
    });
  } catch (err) {
    // The error's name only: a failed append's query error carries its bound
    // parameters — the whole snapshot, prompts and lyric notes included.
    deps.warn?.('track title refill failed; titles will repeat with a number', {
      sessionId,
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/** What the post-lock brief injection needs about a committed fresh vocal submit. */
interface TrackLyricBriefContext {
  /** The validated live snapshot the intent compiled from (base lyric notes intact). */
  snapshot: SessionStyleSnapshot;
  /** The SAME monotonic compile index the intent used — the recompile must not rotate the seed. */
  requestIndex: number;
  providerCaps: CompileMusicInputOptions;
  userPrompt: string | null;
}

/** How many recent briefs feed the variety memory (spec: last 6 generations). */
const RECENT_BRIEFS_LIMIT = 6;

/**
 * The per-generation track lyric brief: one
 * bounded text-LLM call that swaps a fresh lyric direction into the committed
 * fresh submit's `lyricContext` slot, then recompiles with the SAME index and
 * caps. The request row's frozen snapshot is updated BEFORE the paid POST so
 * stored and submitted never disagree — a Dislike reroll of this track
 * re-compiles the row and must reuse this brief. The style identity
 * (`stylePrompt`) stays untouched: `buildSessionStyle` excludes the vocal
 * tail, so the policy-block comparison never sees a brief.
 *
 * Best-effort throughout: any failure (LLM, DB update) or an empty brief
 * returns the static compile unchanged — generation NEVER blocks on the brief,
 * and the adapter's own timeout keeps the latency inside the already-open
 * intent-to-spend → submit window.
 */
async function applyTrackLyricBrief(
  deps: EnsureSessionBufferDeps,
  args: {
    sessionId: string;
    requestId: string;
    staticInput: MusicGenerationInput;
    context: TrackLyricBriefContext;
  },
): Promise<MusicGenerationInput> {
  const { context, staticInput } = args;
  try {
    const llm = await deps.getLlm?.();
    if (!llm) return staticInput;
    // The just-committed intent row is excluded: its frozen snapshot still
    // carries the static base notes (the brief lands on it below), and the
    // base notes already ground the call via `lyricContext` — they are not a
    // brief to differ from, and must not spend a memory slot.
    const previousBriefs = await getRecentLyricBriefs(deps.db, {
      sessionId: args.sessionId,
      limit: RECENT_BRIEFS_LIMIT,
      excludeRequestId: args.requestId,
    });
    const brief = await llm.createTrackLyricBrief({
      lyricContext: context.snapshot.lyricContext,
      language: context.snapshot.language,
      stylePrompt: context.snapshot.stylePrompt,
      mood: context.snapshot.mood,
      previousBriefs,
      ...(context.userPrompt ? { userPrompt: context.userPrompt } : {}),
    });
    if (!brief) {
      // The adapter reports every brief failure as '' (best-effort, sanitized);
      // without this line a dead brief pipeline is invisible in the worker log.
      deps.warn?.('track lyric brief unavailable; submitting static notes', {
        sessionId: args.sessionId,
      });
      return staticInput;
    }

    // The brief rides the existing `lyricContext` slot of a COPY — the
    // session's live snapshot keeps the base notes for the next generation.
    // Re-parsed through the snapshot schema so the slot's own boundary clamp
    // applies: the frozen copy must re-parse to exactly what was submitted (a
    // Dislike reroll re-parses it), whatever an LLM implementation returned.
    const briefedSnapshot = sessionStyleSnapshotSchema.parse({
      ...context.snapshot,
      lyricContext: brief,
    });
    const input = compileMusicGenerationInput(
      briefedSnapshot,
      context.requestIndex,
      context.providerCaps,
    );
    await updateRequestStyleSnapshot(deps.db, {
      requestId: args.requestId,
      styleSnapshot: briefedSnapshot as StyleSnapshot,
    });
    // The compiler never sets `customVoice`; an own-voice submit's resolved
    // reference must survive the recompile.
    return staticInput.customVoice ? { ...input, customVoice: staticInput.customVoice } : input;
  } catch (err) {
    // The error's name only: a failed snapshot update's query error carries its
    // bound parameters — the whole snapshot, prompts and lyric notes included.
    deps.warn?.('track lyric brief failed; submitting the static compile', {
      sessionId: args.sessionId,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return staticInput;
  }
}

/**
 * Issue the paid provider call for an already-recorded `submitting` job and
 * promote it with the captured task id. The `submitting` row was inserted under
 * the per-owner generation lock (intent-to-spend, already counted toward the
 * spend window and the in-flight/concurrency slots); the paid call itself runs
 * here, OUTSIDE any lock or transaction — a provider fetch must never pin one.
 *
 * MONEY SAFETY — the paid `createGenerationTask` must never be issued twice for the
 * same intended track. Two throw windows are made retry-safe:
 *   - the call itself throws (no task id) → park the SAME row, terminal-for-retry:
 *     `submit_rejected` when the failure proves no charge, else `submit_unknown`
 *     (counted toward spend);
 *   - the call returns but persisting its task id throws → record the task id in a
 *     failure-safe path, else park as `submit_unknown`.
 * An uncertain parked row survives as in-flight, so a Graphile retry sees the buffer
 * covered (see `countInFlightSessionJobs`); an unbilled refusal blocks the session
 * through its block signal (`mapProviderBlockSignal`) — until the provider config
 * changes or the listener resumes, or for its status's cooldown when it clears on
 * its own. Either way a retry does NOT re-submit it. The original error is
 * re-raised so Graphile records the attempt.
 */
async function performPaidSubmit(
  deps: EnsureSessionBufferDeps,
  submit: PaidSubmitContext,
  input: MusicGenerationInput,
): Promise<{ taskId: string }> {
  const { jobId } = submit;
  const nowArg = deps.now ? { now: deps.now } : {};

  let task: MusicGenerationTask;
  try {
    task = await deps.music.createGenerationTask(input);
  } catch (err) {
    // The call threw before returning a task id. A `ProviderUnbilledError` proves
    // the provider charged nothing (a definitive refusal, or a rejection made
    // before dialing), so the attempt does not consume the budget window — a
    // provider outage must not degrade every session to `repeat_cost_limit`
    // with zero tracks generated. Everything else may have charged and stays
    // counted. Either way the row is parked where a retry cannot re-dial it.
    if (err instanceof ProviderUnbilledError) {
      // Nothing billed, nothing to ledger.
      await parkUnsubmittedProviderJob(deps.db, {
        jobId,
        outcome: 'submit_rejected',
        ...(err.refusal ? { recoverableAs: RECOVERABLE_REFUSAL_STATUS[err.refusal] } : {}),
        ...nowArg,
      });
    } else {
      await parkUnsubmittedProviderJob(deps.db, { jobId, outcome: 'submit_unknown', ...nowArg });
      await appendPaidCallUsage(deps, submit, { outcome: 'submit_unknown' });
    }
    throw err;
  }

  const diagnostics = task.diagnostics ? { diagnostics: task.diagnostics } : {};
  try {
    await markProviderJobSubmitted(deps.db, {
      jobId,
      providerTaskId: task.providerTaskId,
      ...diagnostics,
      ...nowArg,
    });
  } catch (err) {
    // The call SUCCEEDED (we hold a task id) but persisting it failed. Record it in a
    // failure-safe path so the task is never orphaned or double-charged on retry.
    await recordProviderTaskIdFailSafe(deps.db, {
      jobId,
      providerTaskId: task.providerTaskId,
      ...diagnostics,
      ...nowArg,
    });
    throw err;
  } finally {
    // Whether or not the promote persisted, the paid call went out and returned a
    // task id — ledger it exactly once (best-effort; never throws).
    await appendPaidCallUsage(deps, submit, {
      outcome: 'submitted',
      providerTaskId: task.providerTaskId,
    });
  }
  return { taskId: task.providerTaskId };
}

/**
 * Where an unbilled refusal that clears without any change to the request
 * waits: out of credits as the poll path's credits block, maintenance as a
 * provider error, a rate limit as the provider's backoff. Each blocks the
 * session only for its cooldown (`mapProviderBlockSignal`), then a NEW job is
 * submitted — never this one.
 */
const RECOVERABLE_REFUSAL_STATUS = {
  insufficient_credit: 'blocked_by_provider_credits',
  provider_unavailable: 'failed_final',
  rate_limited: 'provider_rate_limited',
} as const satisfies Record<NonNullable<ProviderUnbilledError['refusal']>, string>;

/**
 * A refused submit waiting out provider maintenance. It keeps the provider-error
 * cooldown but clears on its own, so it reports as the self-clearing backoff
 * with its own copy — never as a dead end the player would offer to delete the
 * Session over.
 */
function isMaintenanceWait(job: { normalizedStatus: string; submitState: string } | null): boolean {
  return (
    job?.normalizedStatus === RECOVERABLE_REFUSAL_STATUS.provider_unavailable &&
    job.submitState === 'submit_rejected'
  );
}

/** The identifiers a paid submit carries out of the lock (job, request, payer). */
interface PaidSubmitContext {
  jobId: string;
  requestId: string;
  ownerUserId: string;
}

/**
 * Append the spend-ledger row for one issued paid call (`usage_events`): written
 * on success AND on an uncertain outcome — either may have charged.
 * BEST-EFFORT by design: the ledger is diagnostics, so a failed append is logged
 * and swallowed — it must never fail (and so Graphile-retry) a paid submit that
 * already went out. Limit enforcement never reads this table (`countTasksInWindow`
 * counts `provider_jobs`), so a lost row cannot under-count spend. No duplicate
 * rows on retry either: a retried tick sees the surviving in-flight job row and
 * never re-enters the submit path.
 */
async function appendPaidCallUsage(
  deps: EnsureSessionBufferDeps,
  submit: PaidSubmitContext,
  call:
    | { outcome: 'submitted'; providerTaskId: string }
    | { outcome: 'submit_unknown'; providerTaskId?: undefined },
): Promise<void> {
  try {
    await recordUsageEvent(deps.db, {
      userId: submit.ownerUserId,
      providerType: 'music',
      providerKey: deps.music.providerKey,
      operation: 'generate',
      // Internal task units: one provider call, regardless of how
      // many tracks it yields.
      units: 1,
      metadata: {
        generationRequestId: submit.requestId,
        providerJobId: submit.jobId,
        outcome: call.outcome,
        ...(call.providerTaskId ? { providerTaskId: call.providerTaskId } : {}),
      },
    });
  } catch (err) {
    deps.warn?.('usage-event append failed for paid submit', {
      providerJobId: submit.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * This worker process's start — the config revision of every env-sourced
 * provider credential, since applying an env change is a restart.
 */
const WORKER_STARTED_AT = new Date();

/**
 * Bind to Graphile, resolving the LIVE usage limits from settings each run (the
 * admin can change them at any time), then running the controller core.
 */
export function createEnsureSessionBufferTask(deps: {
  db: Database;
  getMusic: () => Promise<MusicProvider>;
  getLlm?: () => Promise<LlmProvider | null>;
}): Task {
  return async (payload, helpers) => {
    const music = await deps.getMusic();
    const limits = await getUsageLimits(deps.db);
    await runEnsureSessionBuffer(
      {
        db: deps.db,
        music,
        ...(deps.getLlm ? { getLlm: deps.getLlm } : {}),
        limits,
        workerStartedAt: WORKER_STARTED_AT,
        enqueuePoll: (providerJobId) =>
          enqueuePollAt(helpers.addJob, providerJobId, new Date(Date.now() + FIRST_POLL_DELAY_MS)),
        warn: (message, fields) => helpers.logger.warn(message, fields),
      },
      payload as EnsureSessionBufferPayload,
    );
  };
}
