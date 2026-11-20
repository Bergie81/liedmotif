// Shared machinery for driving ONE Session Cover generation attempt: the
// generator's public types, plan freezing, provider submission, storage
// recovery, landing, and failure settlement. The initial-flow
// orchestration lives in `session-cover-generator.ts` and the regeneration
// planner in `session-cover-regeneration.ts`; both run on this layer, so the
// two paths cannot drift on how an attempt is frozen, submitted, or settled.

import type {
  CoverReferenceRefusal,
  CoverRequestProvenance,
  Database,
  DbOrTx,
  FrozenAttemptFields,
  SessionCoverPlanRecord,
  SessionRecord,
  UsageLimits,
} from '@liedmotif/db';
import {
  emptySessionCoverPlan,
  getCoverImageById,
  getEarliestReadySessionMusicTaskId,
  getSessionById,
  getSessionCoverGenerationById,
  insertGeneratedCoverImage,
  listFinalMp3TrackIdsForSession,
  listRecentSessionCoverGenerations,
  replaceInitialSessionCover,
  setSessionCoverStyleHintNormalized,
  resolveUserProfile,
  updateSessionCoverGeneration,
  withOwnerCoverArtLock,
  type SessionCoverGenerationRow,
} from '@liedmotif/db';
import type {
  GeneratedImageCapabilities,
  GeneratedImageProvider,
  GeneratedImageReference,
  GeneratedImageResult,
} from '@liedmotif/providers';
import { mapWithConcurrency, sanitizeCoverStyleHint, type LogFields } from '@liedmotif/shared';
import { readAllBytes, type StorageProvider } from '@liedmotif/storage';
import type { EvaluateCoverImage, MeasureImage, NormalizeCoverImage } from '@liedmotif/media';
import type { CoverArtworkFinalizer } from './cover-artwork-finalizer';
import {
  buildSessionCoverPlan,
  hashSessionCoverValue,
  SESSION_COVER_PLAN_VERSION,
  SESSION_COVER_PROMPT_VERSION,
} from './cover-plan';
import { storedAutoPick } from './cover-plan-selection';
import {
  classifyCoverSubmissionFailure,
  isReferenceRefusal,
  isTerminalRejection,
  type CoverSubmissionFailure,
} from './cover-submission-retry';
import {
  coverReferenceTreatment,
  EMPTY_COVER_REFERENCE_SELECTION,
  mergeCapabilityDowngrades,
  prepareCoverReferencesForSubmission,
  promptForCoverReferenceSubmission,
  referenceSubjectsForSelection,
  selectCoverReferencesForPlan,
} from './cover-reference-policy';

export interface SessionCoverMetadataQueue {
  enqueue(trackId: string): Promise<void>;
}

export interface SessionCoverLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
}

export interface SessionCoverClock {
  now(): Date;
}

export interface SessionCoverGeneratorDeps {
  db: Database;
  ownerUserId: string;
  imageProvider: GeneratedImageProvider | null;
  storage: StorageProvider;
  evaluateCover?: EvaluateCoverImage;
  normalizeCover?: NormalizeCoverImage;
  measureCover?: MeasureImage;
  metadataQueue: SessionCoverMetadataQueue;
  logger: SessionCoverLogger;
  clock: SessionCoverClock;
  /** Whether the worker has a text LLM: with one, no word list judges a cover's
   *  text (ADR 0004). Required, so no cover job can fall to the word lists by
   *  forgetting it. */
  textLlmConfigured: boolean;
}

export type SessionCoverFallbackReason =
  | 'provider_unconfigured'
  | 'generation_disabled'
  | 'not_admitted'
  | 'invalid_session_name'
  | 'unsupported_capability'
  | 'references_unsupported'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'submission_unknown'
  | 'quality_rejected'
  | 'storage_rejected'
  | 'privacy_rejected';

export type SessionCoverResult =
  | { status: 'ready'; coverImageId: string; generatedNow: boolean }
  | { status: 'pending' }
  | { status: 'fallback'; reason: SessionCoverFallbackReason; coverImageId: string | null }
  | { status: 'preserved'; coverImageId: string }
  | { status: 'missing' };

export class SessionCoverRetryableError extends Error {
  constructor() {
    super('Session Cover generation is temporarily unavailable.');
    this.name = 'SessionCoverRetryableError';
  }
}

export interface Runtime {
  deps: SessionCoverGeneratorDeps;
  evaluate: EvaluateCoverImage;
  finalizer: CoverArtworkFinalizer;
}

export const PENDING_STATES = new Set<SessionCoverGenerationRow['state']>([
  'reserved',
  'planned',
  'submitting',
  'storing',
]);

const SESSION_COVER_SAFE_RETRY_POLICY_VERSION = 'session-cover-safe-retry-v1';
const SESSION_COVER_MAX_SAFE_RETRIES = 1;
const SESSION_COVER_RECOVERY_AGE_MS = 10 * 60 * 1_000;

export function isAged(row: SessionCoverGenerationRow, now: Date): boolean {
  return now.getTime() - row.updatedAt.getTime() >= SESSION_COVER_RECOVERY_AGE_MS;
}

export function persistedCapabilities(
  row: SessionCoverGenerationRow,
): GeneratedImageCapabilities | null {
  const value = row.capabilitySnapshot as Partial<GeneratedImageCapabilities>;
  if (
    !value.provider ||
    value.provider.providerKey !== row.providerKey ||
    value.provider.model !== row.model ||
    !['native', 'recoverable', 'absent'].includes(value.idempotency ?? '')
  ) {
    return null;
  }
  return value as GeneratedImageCapabilities;
}

async function retag(runtime: Runtime, session: SessionRecord): Promise<void> {
  try {
    const trackIds = await listFinalMp3TrackIdsForSession(runtime.deps.db, session.id);
    await mapWithConcurrency(trackIds, 8, (trackId) => runtime.deps.metadataQueue.enqueue(trackId));
  } catch {
    runtime.deps.logger.warn('cover metadata retagging could not be queued', {
      activitySessionId: session.id,
    });
  }
}

async function land(runtime: Runtime, session: SessionRecord, coverImageId: string) {
  const changed = await replaceInitialSessionCover(runtime.deps.db, {
    ownerUserId: session.ownerUserId,
    sessionId: session.id,
    coverImageId,
  });
  if (changed) await retag(runtime, session);
  return changed;
}

/**
 * Failure settlement: report whatever cover the session currently
 * wears — the branded placeholder for a failed initial attempt, the previously
 * landed cover for a failed user regeneration.
 */
export async function currentCoverFallback(
  runtime: Runtime,
  session: SessionRecord,
  reason: SessionCoverFallbackReason,
): Promise<SessionCoverResult> {
  const current = await getSessionById(runtime.deps.db, {
    ownerUserId: session.ownerUserId,
    sessionId: session.id,
  });
  return { status: 'fallback', reason, coverImageId: current?.coverImageId ?? null };
}

export function fallbackForLedger(row: SessionCoverGenerationRow): SessionCoverFallbackReason {
  if (row.failureCategory === 'invalid_session_name') return 'invalid_session_name';
  if (row.failureCategory === 'provider_unconfigured') return 'provider_unconfigured';
  if (row.failureCategory === 'generation_disabled') return 'generation_disabled';
  if (row.failureCategory === 'unsupported_capability') {
    return 'unsupported_capability';
  }
  if (row.failureCategory === 'references_unsupported') return 'references_unsupported';
  // An attempt refused at admission because its provider could not run (e.g. a
  // music-task-driven cover whose source task never landed) is a provider
  // problem, not a budget refusal.
  if (row.failureCategory === 'provider_unavailable') return 'provider_unavailable';
  switch (row.state) {
    case 'not_admitted':
      return 'not_admitted';
    case 'quality_rejected':
      return 'quality_rejected';
    case 'provider_rejected':
      return 'provider_rejected';
    case 'submission_unknown':
      return 'submission_unknown';
    case 'storage_rejected':
      return 'storage_rejected';
    case 'privacy_rejected':
      return 'privacy_rejected';
    default:
      return 'provider_unavailable';
  }
}

export async function resultFromExisting(
  runtime: Runtime,
  session: SessionRecord,
  ledger: SessionCoverGenerationRow,
): Promise<SessionCoverResult> {
  if (PENDING_STATES.has(ledger.state)) return { status: 'pending' };
  if (ledger.trigger === 'user_regenerate') {
    // Terminal regeneration attempts never re-land: the user may have moved on
    // (re-selected an older cover) since the attempt settled.
    if (ledger.state === 'ready') {
      return { status: 'ready', coverImageId: ledger.coverImageId, generatedNow: false };
    }
    return currentCoverFallback(runtime, session, fallbackForLedger(ledger));
  }
  if (ledger.state === 'ready') {
    const cover = await getCoverImageById(runtime.deps.db, ledger.coverImageId);
    if (cover && (await runtime.deps.storage.stat(ledger.storageKey))) {
      // Retagging rides `land()` — only an attempt that actually re-points the
      // session this run enqueues embeds. A session already wearing this cover
      // is the recovery cron's steady state; re-enqueueing every final MP3 on
      // each pass would be pure churn (embeds also self-heal per track: every
      // download, BPM landing, and rename re-enqueues its own).
      const landed = await land(runtime, session, cover.id);
      if (landed || session.coverImageId === cover.id) {
        return { status: 'ready', coverImageId: cover.id, generatedNow: false };
      }
      const fresh = await getSessionById(runtime.deps.db, {
        ownerUserId: session.ownerUserId,
        sessionId: session.id,
      });
      if (fresh?.coverImageId) return { status: 'preserved', coverImageId: fresh.coverImageId };
    }
    return currentCoverFallback(runtime, session, 'storage_rejected');
  }
  return currentCoverFallback(runtime, session, fallbackForLedger(ledger));
}

function coverReferenceContext(session: SessionRecord): string {
  return session.userPrompt ?? '';
}

export interface FrozenPlanInputs {
  planned: ReturnType<typeof buildSessionCoverPlan>;
  referenceSelection: Awaited<ReturnType<typeof selectCoverReferencesForPlan>>;
  plan: SessionCoverPlanRecord;
  terminalReason: string | null;
  recentPlanCount: number;
}

/**
 * The state a refused attempt settles in. A privacy block keeps its own state so
 * the reason survives as more than a budget refusal; every other refusal is an
 * admission no.
 */
export function refusedCoverState(failureCategory: string): SessionCoverGenerationRow['state'] {
  return failureCategory === 'privacy_rejected' ? 'privacy_rejected' : 'not_admitted';
}

/** The first terminal refusal that applies, in precedence order; null admits. */
export function terminalReasonFor(args: {
  forcedTerminalReason?: string;
  /** A prompt-driven attempt while the owner has tailored cover art switched off. */
  tailoredCoverArtDenied: boolean;
  referenceTerminalReason: string | null;
  planningFailure: string | null;
  withinLimits: boolean;
  planOk: boolean;
}): string | null {
  if (args.forcedTerminalReason) return args.forcedTerminalReason;
  if (args.tailoredCoverArtDenied) return 'generation_disabled';
  if (args.referenceTerminalReason) return args.referenceTerminalReason;
  if (args.planningFailure) {
    return args.planningFailure === 'invalid_name' ? 'invalid_session_name' : args.planningFailure;
  }
  if (!args.withinLimits) return 'not_admitted';
  return args.planOk ? null : 'invalid_session_name';
}

export type SessionCoverPlanInput = Parameters<typeof buildSessionCoverPlan>[0];

export interface RelaxedCoverPlan {
  planned: ReturnType<typeof buildSessionCoverPlan>;
  /** The FIRST build's refusal — a relaxed re-plan never revises admission. */
  planningFailure: string | null;
}

/**
 * Build the frozen plan, re-planning once without the provider's prompt-length
 * cap when the grammar overflows it: the original refusal still decides
 * admission, but the relaxed plan keeps provenance/alt text usable on the
 * settled attempt.
 */
export function buildPlanWithRelaxedRetry(planInput: SessionCoverPlanInput): RelaxedCoverPlan {
  let planned = buildSessionCoverPlan(planInput);
  const planningFailure = planned.ok ? null : planned.reason;
  if (!planned.ok && planned.reason === 'unsupported_capability') {
    planned = buildSessionCoverPlan({
      ...planInput,
      capabilities: { ...planInput.capabilities, maxPromptCharacters: undefined },
    });
  }
  return { planned, planningFailure };
}

/**
 * Freeze every creative input of one attempt (references, custom definition,
 * style grammar plan, terminal fallback) and derive the terminal refusal
 * reason, if any. Shared by initial admission and user regeneration so the two
 * paths cannot drift.
 */
export async function freezePlanInputs(
  tx: DbOrTx,
  session: SessionRecord,
  capabilities: GeneratedImageCapabilities,
  args: {
    limits: UsageLimits;
    withinLimits: boolean;
    forcedTerminalReason?: string;
    /** What a regeneration request froze at reservation. Names match only in
     *  the typed `userGuidance`, so the Writing AI's rewrite can neither add nor
     *  drop a Person; `usePeopleReferences` false sends no photos, true asks
     *  for them without the frequency roll, absent keeps the Session's rules. */
    request?: CoverRequestProvenance;
    textLlmConfigured: boolean;
  },
): Promise<FrozenPlanInputs> {
  const request = args.request ?? {};
  const recentPlans = await listRecentSessionCoverGenerations(tx, {
    ownerUserId: session.ownerUserId,
    limit: 24,
  });
  const referenceSelection =
    request.usePeopleReferences === false
      ? EMPTY_COVER_REFERENCE_SELECTION
      : await selectCoverReferencesForPlan(tx, {
          ownerUserId: session.ownerUserId,
          contextId: session.id,
          promptText: coverReferenceContext(session),
          capabilities,
          skipProfile: session.skipProfile,
          includesListener: session.includesListener,
          explicitOptIn: request.usePeopleReferences === true,
          coverWish: request.userGuidance,
          wishIncludesListener: request.wishIncludesListener,
        });
  const customDefinition =
    session.coverStyle === 'custom'
      ? sanitizeCoverStyleHint(session.coverStyleHintNormalized ?? session.coverStyleHint ?? '')
      : '';
  if (session.coverStyle === 'custom' && session.coverStyleHintNormalized === null) {
    await setSessionCoverStyleHintNormalized(tx, {
      ownerUserId: session.ownerUserId,
      sessionId: session.id,
      normalized: customDefinition,
    });
  }
  const planInput = {
    sessionId: session.id,
    sessionName: session.title,
    coverConcept: session.coverConcept,
    coverStyle: session.coverStyle,
    autoCoverStyle: session.autoCoverStyle,
    textLlmConfigured: args.textLlmConfigured,
    customDefinition,
    snapshot: session.sessionStyleSnapshot ?? {},
    sessionIntent: session.userPrompt,
    userGuidance: request.effectiveGuidance || request.userGuidance || null,
    capabilities,
    referenceTreatment: coverReferenceTreatment(referenceSelection.selectedReferences),
    referenceSubjectCount: new Set(
      referenceSelection.selectedReferences.map((reference) => reference.personId),
    ).size,
    selectedPersonIds: referenceSelection.selectedPersonIds,
    referenceSubjects: referenceSubjectsForSelection(referenceSelection),
    persistedStyleFallbackReason: session.coverStyleFallbackReason,
    recentFingerprints: recentPlans.map((row) => row.fingerprint),
  };
  const { planned, planningFailure } = buildPlanWithRelaxedRetry(planInput);
  const name = session.title?.normalize('NFC').trim() ?? '';
  const plan: SessionCoverPlanRecord = planned.ok
    ? planned.plan
    : emptySessionCoverPlan({
        sessionName: name,
        selectedStyle: session.coverStyle,
        resolvedStyle:
          session.coverStyle === 'auto'
            ? (storedAutoPick(session.autoCoverStyle) ?? 'auto')
            : session.coverStyle,
        styleFallbackReason: session.coverStyleFallbackReason,
        conceptMode: 'title symbol',
        selectedPersonIds: referenceSelection.selectedPersonIds,
        altText: name || 'Session cover',
        diversityRelaxedAxes: [],
      });
  // Prompt planning can only refuse a PROMPT-DRIVEN attempt: a music-task
  // provider ignores the plan entirely, so a name/style planning failure must
  // not deny it (the frozen plan still records provenance/alt text). The
  // tailored-cover-art switch is prompt-driven for the same reason — it decides
  // whether the image provider paints, not whether covers happen at all.
  const promptDriven = !capabilities.musicTaskSource;
  const terminalReason = terminalReasonFor({
    ...(args.forcedTerminalReason ? { forcedTerminalReason: args.forcedTerminalReason } : {}),
    tailoredCoverArtDenied: promptDriven && !args.limits.tailoredCoverArtEnabled,
    referenceTerminalReason: referenceSelection.terminalReason,
    planningFailure: promptDriven ? planningFailure : null,
    withinLimits: args.withinLimits,
    planOk: promptDriven ? planned.ok : true,
  });
  return { planned, referenceSelection, plan, terminalReason, recentPlanCount: recentPlans.length };
}

/**
 * What the reserve step froze onto the attempt and the worker's own planning
 * cannot reconstruct: the private guidance provenance and the People request.
 * Re-planning merges it back over the freshly built plan, so a re-plan, a retry,
 * and a recovery all answer to the request the user actually made.
 */
export function reservedRequestProvenance(
  reserved: SessionCoverPlanRecord,
): CoverRequestProvenance {
  const {
    userGuidance,
    effectiveGuidance,
    enhancementApplied,
    wishIncludesListener,
    usePeopleReferences,
  } = reserved;
  return {
    userGuidance,
    effectiveGuidance,
    enhancementApplied,
    wishIncludesListener,
    usePeopleReferences,
  };
}

/**
 * The provider-facing fields every frozen attempt persists identically — one
 * assembly for the initial insert and the reserved-row plan application.
 * `plan` is passed explicitly because regeneration merges the private guidance
 * provenance into the frozen plan before hashing.
 */
export function frozenAttemptFields(
  frozen: FrozenPlanInputs,
  plan: SessionCoverPlanRecord,
  capabilities: GeneratedImageCapabilities,
): FrozenAttemptFields {
  return {
    plan,
    planVersion: SESSION_COVER_PLAN_VERSION,
    promptVersion: SESSION_COVER_PROMPT_VERSION,
    planHash: hashSessionCoverValue(plan),
    promptHash: hashSessionCoverValue(plan.prompt),
    fingerprint: frozen.planned.ok ? frozen.planned.fingerprint : {},
    providerKey: capabilities.provider.providerKey,
    model: capabilities.provider.model,
    capabilitySnapshot: capabilities as unknown as Record<string, unknown>,
    capabilityDowngrades: frozen.referenceSelection.capabilityDowngrades,
    retryPolicy: {
      version: SESSION_COVER_SAFE_RETRY_POLICY_VERSION,
      maxSafeRetries: SESSION_COVER_MAX_SAFE_RETRIES,
      requireSameIdempotencyKey: true,
      recentHistoryObserved: frozen.recentPlanCount,
    },
    selectedReferences: frozen.referenceSelection.selectedReferences,
    ...(frozen.planned.ok && capabilities.nativeSeed ? { seed: String(frozen.planned.seed) } : {}),
    maxSafeRetries: SESSION_COVER_MAX_SAFE_RETRIES,
  };
}

/**
 * The session's source music task for a music-task-driven provider, or null
 * while none is ready. The answer can change when an older task turns ready
 * later, and the provider allows one cover per music task, so admission pins
 * the task it saw on the attempt and every retry submits that one.
 */
export function readySourceMusicTaskId(
  db: DbOrTx,
  session: SessionRecord,
  source: NonNullable<GeneratedImageCapabilities['musicTaskSource']>,
): Promise<string | null> {
  return getEarliestReadySessionMusicTaskId(db, {
    ownerUserId: session.ownerUserId,
    activitySessionId: session.id,
    providerKey: source.musicProviderKey,
  });
}

/**
 * The `musicTaskId` a submission must carry: `undefined` for prompt-driven
 * providers, else the task pinned on the attempt at admission. An attempt
 * without a pin resolves it now; not ready yet → retryable: the cover job (and
 * later the aged recovery scan) re-drives the attempt once the session's first
 * task lands.
 */
async function resolveCoverMusicTaskId(
  db: DbOrTx,
  session: SessionRecord,
  ledger: SessionCoverGenerationRow,
  capabilities: GeneratedImageCapabilities,
): Promise<string | undefined> {
  if (!capabilities.musicTaskSource) return undefined;
  const pinned = ledger.retryPolicy.sourceMusicTaskId;
  if (typeof pinned === 'string') return pinned;
  const taskId = await readySourceMusicTaskId(db, session, capabilities.musicTaskSource);
  if (!taskId) throw new SessionCoverRetryableError();
  return taskId;
}

export type SubmitFailureState =
  'planned' | 'submission_unknown' | 'provider_rejected' | 'provider_unavailable';

function submitFailureState(
  failure: CoverSubmissionFailure,
  idempotency: GeneratedImageCapabilities['idempotency'],
): SubmitFailureState {
  if (failure.retry) return 'planned';
  if (failure.disposition === 'outcome_unknown' && idempotency === 'absent') {
    return 'submission_unknown';
  }
  if (isTerminalRejection(failure.kind)) return 'provider_rejected';
  return 'provider_unavailable';
}

/**
 * The ledger state is coarse (a pg enum), so the cause an Admin can act on
 * rides the failure category: an account not ready for images is told apart
 * from any other provider rejection.
 */
function submitFailureCategory(failure: CoverSubmissionFailure, state: SubmitFailureState): string {
  if (failure.retry) return 'safe_retry_pending';
  return failure.kind === 'account_not_ready' ? 'account_not_ready' : state;
}

/** Claim a `planned` attempt for submission; false means another run holds it. */
export async function claimCoverSubmission(
  db: DbOrTx,
  args: { ownerUserId: string; id: string; now: Date },
): Promise<boolean> {
  return updateSessionCoverGeneration(db, {
    ownerUserId: args.ownerUserId,
    id: args.id,
    state: 'submitting',
    possiblyPaid: true,
    submittedAt: args.now,
    updatedAt: args.now,
    expectedStates: ['planned'],
  });
}

export type CoverSubmissionOutcome =
  | { kind: 'generated'; generated: GeneratedImageResult; requestDowngrades: string[] }
  | { kind: 'retry' }
  | { kind: SubmitFailureState };

/**
 * One paid provider call for a claimed (`submitting`) attempt. Success lands
 * the row in `storing` with the provider outcome; failure classifies the error
 * under the safe-retry rule and settles (or re-opens) the row. `claimed` is
 * the row as claimed for submission; `possiblyPaidBefore` and
 * `submittedAtBefore` are the pre-claim spend a not-started failure restores, so
 * an earlier possibly-paid submission keeps counting in its own window.
 */
export async function generateCoverSubmission(
  db: DbOrTx,
  args: {
    provider: GeneratedImageProvider;
    ownerUserId: string;
    claimed: SessionCoverGenerationRow;
    possiblyPaidBefore: boolean;
    submittedAtBefore: Date | null;
    capabilities: GeneratedImageCapabilities;
    now: Date;
    prompt: string;
    references: GeneratedImageReference[];
    musicTaskId?: string;
    mergeDowngrades(codes: GeneratedImageResult['downgradeCodes']): string[];
  },
): Promise<
  CoverSubmissionOutcome | { kind: 'pending' } | { kind: 'refused'; reason: CoverReferenceRefusal }
> {
  const { claimed, capabilities, now } = args;
  const spendBefore = {
    possiblyPaid: args.possiblyPaidBefore,
    submittedAt: args.possiblyPaidBefore ? args.submittedAtBefore : null,
  };
  let generated: GeneratedImageResult;
  try {
    generated = await args.provider.generate({
      purpose: 'session-cover',
      positivePrompt: args.prompt,
      exclusions: claimed.plan.exclusions,
      target: { shape: 'square', quality: 'high' },
      references: args.references,
      idempotencyKey: claimed.idempotencyKey,
      ...(capabilities.nativeSeed && claimed.seed ? { seed: Number(claimed.seed) } : {}),
      ...(args.musicTaskId ? { musicTaskId: args.musicTaskId } : {}),
      count: 1,
    });
  } catch (error) {
    // The adapter refused before the request left because the model cannot take
    // the frozen photos: settled like the claim-time reference refusal, since no
    // resend can carry them.
    if (isReferenceRefusal(error)) {
      await updateSessionCoverGeneration(db, {
        ownerUserId: args.ownerUserId,
        id: claimed.id,
        state: refusedCoverState('references_unsupported'),
        ...spendBefore,
        submissionDisposition: 'not_started',
        failureCategory: 'references_unsupported',
        settledAt: now,
        updatedAt: now,
        expectedStates: ['submitting'],
      });
      return { kind: 'refused', reason: 'references_unsupported' };
    }
    const failure = classifyCoverSubmissionFailure(error, claimed, capabilities.idempotency);
    const state = submitFailureState(failure, capabilities.idempotency);
    await updateSessionCoverGeneration(db, {
      ownerUserId: args.ownerUserId,
      id: claimed.id,
      state,
      ...(failure.disposition === 'not_started' ? spendBefore : { possiblyPaid: true }),
      submissionDisposition: failure.disposition,
      safeRetryCount: failure.safeRetryCount,
      failureCategory: submitFailureCategory(failure, state),
      settledAt: failure.retry ? null : now,
      updatedAt: now,
      expectedStates: ['submitting'],
    });
    return failure.retry ? { kind: 'retry' } : { kind: state };
  }
  // Outside the provider `try`: a failed write here is a database error, not a
  // provider outcome, so it propagates as retryable and leaves `submitting` to
  // the aged recovery.
  const requestDowngrades = args.mergeDowngrades(generated.downgradeCodes);
  const stored = await updateSessionCoverGeneration(db, {
    ownerUserId: args.ownerUserId,
    id: claimed.id,
    state: 'storing',
    possiblyPaid: true,
    providerOperationId: generated.operationId ?? null,
    submissionDisposition: 'completed',
    costUsd: generated.reportedCostUsd ?? null,
    capabilityDowngrades: requestDowngrades,
    updatedAt: now,
    expectedStates: ['submitting'],
  });
  // The attempt moved on while the provider ran (a Playlist or Member delete
  // settled it, or the aged recovery took it over): this run's bytes would have
  // no row to reclaim them, so none are written.
  if (!stored) return { kind: 'pending' };
  return { kind: 'generated', generated, requestDowngrades };
}

/** An attempt that never reached the provider: another run holds the claim, or
 *  the frozen reference selection could not be honored. */
export type UnsubmittedCover =
  | { kind: 'pending' }
  | { kind: 'refused'; reason: CoverReferenceRefusal }
  | { kind: 'not_admitted' };

type ClaimedCoverSubmission =
  | {
      kind: 'claimed';
      current: SessionCoverGenerationRow;
      references: GeneratedImageReference[];
      referencesOmitted: boolean;
    }
  | UnsubmittedCover;

export type CoverSubmissionResult = CoverSubmissionOutcome | UnsubmittedCover;

/**
 * Claim a `planned` attempt and prepare its reference bytes under the owner
 * cover-art lock — the privacy window a hard opt-out (a `never` switch, a
 * deleted photo) must not race.
 */
async function claimUnderCoverArtLock(
  db: Database,
  args: {
    ownerUserId: string;
    ledger: SessionCoverGenerationRow;
    capabilities: GeneratedImageCapabilities;
    storage: StorageProvider;
    now: Date;
  },
): Promise<ClaimedCoverSubmission> {
  const { ownerUserId, ledger, capabilities, storage, now } = args;
  return withOwnerCoverArtLock(db, ownerUserId, async (tx) => {
    // Admission ran when the attempt was planned; a safe retry re-enters here
    // without it, so a Disable since then must still stop the paid call.
    if ((await resolveUserProfile(tx, ownerUserId))?.disabledAt) {
      const settled = await updateSessionCoverGeneration(tx, {
        ownerUserId,
        id: ledger.id,
        state: 'not_admitted',
        possiblyPaid: ledger.possiblyPaid,
        failureCategory: 'account_disabled',
        settledAt: now,
        updatedAt: now,
        expectedStates: ['planned'],
      });
      return settled ? { kind: 'not_admitted' } : { kind: 'pending' };
    }
    const claimed = await claimCoverSubmission(tx, { ownerUserId, id: ledger.id, now });
    if (!claimed) return { kind: 'pending' };
    const current = await getSessionCoverGenerationById(tx, { ownerUserId, id: ledger.id });
    if (!current || current.state !== 'submitting') return { kind: 'pending' };
    const prepared = await prepareCoverReferencesForSubmission(tx, {
      ownerUserId,
      selectedReferences: current.selectedReferences,
      capabilities,
      storage,
    });
    if (!prepared.ok) {
      // This claim reached no provider, but a safe retry's earlier submission
      // may have: that spend keeps counting in its window.
      await updateSessionCoverGeneration(tx, {
        ownerUserId,
        id: ledger.id,
        state: refusedCoverState(prepared.reason),
        possiblyPaid: ledger.possiblyPaid,
        submissionDisposition: 'not_started',
        submittedAt: ledger.possiblyPaid ? ledger.submittedAt : null,
        failureCategory: prepared.reason,
        settledAt: now,
        updatedAt: now,
        expectedStates: ['submitting'],
      });
      return { kind: 'refused', reason: prepared.reason };
    }
    const { references, referencesOmitted } = prepared;
    if (referencesOmitted) {
      await updateSessionCoverGeneration(tx, {
        ownerUserId,
        id: ledger.id,
        state: 'submitting',
        capabilityDowngrades: ['references_omitted'],
        updatedAt: now,
        expectedStates: ['submitting'],
      });
    }
    return { kind: 'claimed', current, references, referencesOmitted };
  });
}

/**
 * Drive one planned attempt through its paid submission: claim and read the
 * reference photos inside the privacy lock, then pay for the image with the lock
 * released — on the plain db handle (the music path's rule,
 * `ensure-session-buffer.ts`), because a slow provider must never pin a pg
 * connection, the owner-wide cover lock, and a worker slot for minutes. Both
 * halves live here so that ordering is a property of the machinery, not
 * something each cover subject has to remember.
 *
 * The outcome transitions are expectedStates-guarded, so a state that moved on
 * while the provider ran (recovery, deletion) wins the race and the stale
 * recording no-ops.
 */
export async function claimAndSubmitCover(
  db: Database,
  args: {
    provider: GeneratedImageProvider;
    ownerUserId: string;
    ledger: SessionCoverGenerationRow;
    capabilities: GeneratedImageCapabilities;
    storage: StorageProvider;
    now: Date;
    musicTaskId?: string;
  },
): Promise<CoverSubmissionResult> {
  const claimed = await claimUnderCoverArtLock(db, args);
  if (claimed.kind !== 'claimed') return claimed;
  const { current, references, referencesOmitted } = claimed;
  return generateCoverSubmission(db, {
    provider: args.provider,
    ownerUserId: args.ownerUserId,
    claimed: current,
    possiblyPaidBefore: args.ledger.possiblyPaid,
    submittedAtBefore: args.ledger.submittedAt,
    capabilities: args.capabilities,
    now: args.now,
    prompt: promptForCoverReferenceSubmission(current.plan.prompt, referencesOmitted),
    references,
    ...(args.musicTaskId ? { musicTaskId: args.musicTaskId } : {}),
    mergeDowngrades: (codes) =>
      mergeCapabilityDowngrades(
        current.capabilityDowngrades,
        referencesOmitted ? ['references_omitted'] : [],
        codes,
      ),
  });
}

async function submit(
  runtime: Runtime,
  session: SessionRecord,
  ledger: SessionCoverGenerationRow,
  capabilities: GeneratedImageCapabilities,
  now: Date,
): Promise<CoverSubmissionResult> {
  // Resolved BEFORE the state claim: a not-yet-ready source task must leave the
  // attempt 'planned' (retryable) instead of burning a submitting claim.
  const musicTaskId = await resolveCoverMusicTaskId(runtime.deps.db, session, ledger, capabilities);
  return claimAndSubmitCover(runtime.deps.db, {
    provider: runtime.deps.imageProvider!,
    ownerUserId: session.ownerUserId,
    ledger,
    capabilities,
    storage: runtime.deps.storage,
    now,
    ...(musicTaskId ? { musicTaskId } : {}),
  });
}

/**
 * The generation provenance persisted onto every processed cover image.
 * `branded` records the stored treatment so audits never need to infer it from
 * the cover's subject or inspect pixels: storage pipelines never composite the
 * badge — it exists only in embedded album art — so stored bytes are clean.
 */
export function processedCoverProvenance(
  ledger: SessionCoverGenerationRow,
  args: {
    now: Date;
    capabilityDowngrades: string[];
    costUsd: number | null;
  },
): Record<string, unknown> {
  return {
    provider: ledger.providerKey,
    planVersion: ledger.planVersion,
    promptVersion: ledger.promptVersion,
    planHash: ledger.planHash,
    promptHash: ledger.promptHash,
    fingerprint: ledger.fingerprint,
    capabilitySnapshotHash: hashSessionCoverValue(ledger.capabilitySnapshot),
    capabilityDowngrades: args.capabilityDowngrades,
    ...(args.costUsd === null ? {} : { costUsd: args.costUsd }),
    branded: false,
    generatedAt: args.now.toISOString(),
  };
}

/**
 * Persist a processed cover's `cover_images` row and settle the attempt
 * `ready`. `insertCoverImage` writes the subject-specific image row; the
 * ledger transition is identical for every subject.
 */
export async function settleProcessedCoverReady(
  db: DbOrTx,
  args: {
    ownerUserId: string;
    ledger: SessionCoverGenerationRow;
    now: Date;
    insertCoverImage(): Promise<unknown>;
  },
): Promise<void> {
  await args.insertCoverImage();
  await updateSessionCoverGeneration(db, {
    ownerUserId: args.ownerUserId,
    id: args.ledger.id,
    state: 'ready',
    possiblyPaid: true,
    settledAt: args.now,
    updatedAt: args.now,
    expectedStates: ['storing'],
  });
}

async function persistAndLandProcessedCover(
  runtime: Runtime,
  session: SessionRecord,
  ledger: SessionCoverGenerationRow,
  args: {
    now: Date;
    capabilityDowngrades: string[];
    costUsd: number | null;
    generatedNow: boolean;
    byteSize: number;
  },
): Promise<SessionCoverResult> {
  await settleProcessedCoverReady(runtime.deps.db, {
    ownerUserId: session.ownerUserId,
    ledger,
    now: args.now,
    insertCoverImage: () =>
      insertGeneratedCoverImage(runtime.deps.db, {
        id: ledger.coverImageId,
        ownerUserId: session.ownerUserId,
        activitySessionId: session.id,
        storageProvider: runtime.deps.storage.providerKey,
        storageKey: ledger.storageKey,
        byteSize: args.byteSize,
        label: ledger.plan.altText,
        model: ledger.model,
        activityFit: [],
        moodFit: [],
        genreFit: [],
        energyFit: [],
        visualTheme: ledger.plan.resolvedStyle,
        provenance: {
          ...processedCoverProvenance(ledger, args),
          referenceIds: ledger.selectedReferences.map((reference) => reference.id),
        },
      }),
  });
  if (ledger.trigger === 'user_regenerate') {
    // A regenerated cover never lands by itself: it joins the session's history
    // and waits for the user to confirm the swap (the select route re-points).
    return { status: 'ready', coverImageId: ledger.coverImageId, generatedNow: args.generatedNow };
  }
  const landed = await land(runtime, session, ledger.coverImageId);
  if (!landed) {
    const current = await getSessionById(runtime.deps.db, {
      ownerUserId: session.ownerUserId,
      sessionId: session.id,
    });
    if (current?.coverImageId === ledger.coverImageId) await retag(runtime, session);
    else if (current?.coverImageId) {
      return { status: 'preserved', coverImageId: current.coverImageId };
    }
  }
  return { status: 'ready', coverImageId: ledger.coverImageId, generatedNow: args.generatedNow };
}

/**
 * Re-drive a `storing` attempt from its stored bytes (a crash-recovery
 * reentry): missing or unsound bytes settle the attempt via `settle`, sound
 * bytes persist via `persist`. The rejection states and failure categories are
 * fixed here so every subject reports storage recovery identically.
 */
export async function recoverStoredCoverBytes<R>(args: {
  storage: StorageProvider;
  evaluate: EvaluateCoverImage;
  ledger: SessionCoverGenerationRow;
  settle(state: 'storage_rejected' | 'quality_rejected', failureCategory: string): Promise<R>;
  persist(byteSize: number): Promise<R>;
}): Promise<R> {
  let byteSize: number;
  try {
    if (!(await args.storage.stat(args.ledger.storageKey))) {
      return await args.settle('storage_rejected', 'stored_asset_missing');
    }
    const bytes = await readAllBytes(await args.storage.readStream(args.ledger.storageKey));
    const quality = await args.evaluate(bytes);
    if (!quality.ok || quality.width !== quality.height) {
      return await args.settle('quality_rejected', 'stored_asset_invalid');
    }
    byteSize = bytes.byteLength;
  } catch {
    return args.settle('storage_rejected', 'storage_recovery_rejected');
  }
  // Sound bytes are on the key: a failure persisting them is retryable and
  // leaves the attempt `storing` for the next recovery pass.
  return args.persist(byteSize);
}

export async function recoverStoredCover(
  runtime: Runtime,
  session: SessionRecord,
  ledger: SessionCoverGenerationRow,
  now: Date,
): Promise<SessionCoverResult> {
  return recoverStoredCoverBytes({
    storage: runtime.deps.storage,
    evaluate: runtime.evaluate,
    ledger,
    settle: async (state, failureCategory) => {
      await updateSessionCoverGeneration(runtime.deps.db, {
        ownerUserId: session.ownerUserId,
        id: ledger.id,
        state,
        possiblyPaid: true,
        failureCategory,
        settledAt: now,
        updatedAt: now,
        expectedStates: ['storing'],
      });
      return currentCoverFallback(runtime, session, state);
    },
    persist: (byteSize) =>
      persistAndLandProcessedCover(runtime, session, ledger, {
        now,
        capabilityDowngrades: ledger.capabilityDowngrades,
        costUsd: ledger.costUsd,
        generatedNow: false,
        byteSize,
      }),
  });
}

async function rejectProcessedCover(
  runtime: Runtime,
  session: SessionRecord,
  ledger: SessionCoverGenerationRow,
  now: Date,
  failureCategory: string,
): Promise<SessionCoverResult> {
  await updateSessionCoverGeneration(runtime.deps.db, {
    ownerUserId: session.ownerUserId,
    id: ledger.id,
    state: 'quality_rejected',
    possiblyPaid: true,
    failureCategory,
    settledAt: now,
    updatedAt: now,
    expectedStates: ['storing'],
  });
  return currentCoverFallback(runtime, session, 'quality_rejected');
}

export async function executePlannedCover(
  runtime: Runtime,
  session: SessionRecord,
  ledger: SessionCoverGenerationRow,
  capabilities: GeneratedImageCapabilities,
  now: Date,
): Promise<SessionCoverResult> {
  const submitted = await submit(runtime, session, ledger, capabilities, now);
  if (submitted.kind !== 'generated') {
    if (submitted.kind === 'retry') throw new SessionCoverRetryableError();
    if (submitted.kind === 'pending') return { status: 'pending' };
    const row = await getSessionCoverGenerationById(runtime.deps.db, {
      ownerUserId: session.ownerUserId,
      id: ledger.id,
    });
    return currentCoverFallback(
      runtime,
      session,
      row ? fallbackForLedger(row) : 'provider_unavailable',
    );
  }

  const processed = await runtime.finalizer.finish({ bytes: submitted.generated.bytes });
  if (!processed.ok) return rejectProcessedCover(runtime, session, ledger, now, processed.reason);

  try {
    await runtime.deps.storage.write({
      key: ledger.storageKey,
      body: processed.bytes,
      mimeType: 'image/webp',
    });
  } catch {
    await updateSessionCoverGeneration(runtime.deps.db, {
      ownerUserId: session.ownerUserId,
      id: ledger.id,
      state: 'storage_rejected',
      possiblyPaid: true,
      failureCategory: 'storage_rejected',
      settledAt: now,
      updatedAt: now,
      expectedStates: ['storing'],
    });
    return currentCoverFallback(runtime, session, 'storage_rejected');
  }
  const ready = await persistAndLandProcessedCover(runtime, session, ledger, {
    now,
    capabilityDowngrades: submitted.requestDowngrades,
    costUsd: submitted.generated.reportedCostUsd ?? null,
    generatedNow: true,
    byteSize: processed.bytes.byteLength,
  });
  if (ready.status === 'ready') {
    runtime.deps.logger.info('generated session cover', {
      activitySessionId: session.id,
      coverImageId: ledger.coverImageId,
    });
  }
  return ready;
}
