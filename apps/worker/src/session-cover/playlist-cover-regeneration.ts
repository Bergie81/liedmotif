// Playlist cover regeneration (the same machinery as a Session Cover). Drives
// ONE reserved user-triggered attempt — created by the playlist regenerate API
// route with the frozen style pick, guidance, and People-reference request — to
// a terminal state. The plan is built from the playlist's NAME plus its
// deterministic member-derived context (dominant member genre tags), never a
// Style Snapshot or music task. An attempt is prompt-only unless the owner
// explicitly asked it to carry Person reference photos, in which case it
// delivers them or refuses. A ready cover only joins the playlist's history —
// the user confirms the swap through the select route — and any failure leaves
// the current cover untouched.

import type { Database, DbOrTx, SessionCoverPlanRecord } from '@liedmotif/db';
import {
  emptySessionCoverPlan,
  coverAdmissionDecision,
  getPlaylistCoverSubject,
  getSessionCoverGenerationById,
  getUsageLimits,
  insertGeneratedPlaylistCoverImage,
  listRecentSessionCoverGenerations,
  planReservedSessionCoverGeneration,
  updateSessionCoverGeneration,
  withOwnerCoverAdmissionLock,
  type PlaylistCoverSubject,
  type SessionCoverGenerationRow,
} from '@liedmotif/db';
import {
  GeneratedImageProviderError,
  type GeneratedImageCapabilities,
  type GeneratedImageProvider,
} from '@liedmotif/providers';
import { COVER_STYLES, type CoverStyle } from '@liedmotif/shared';
import type { StorageProvider } from '@liedmotif/storage';
import {
  evaluateCoverImage,
  type EvaluateCoverImage,
  type MeasureImage,
  type NormalizeCoverImage,
} from '@liedmotif/media';
import { createCoverArtworkFinalizer, type CoverArtworkFinalizer } from './cover-artwork-finalizer';
import {
  hashSessionCoverValue,
  SESSION_COVER_PLAN_VERSION,
  SESSION_COVER_PROMPT_VERSION,
  withOrdinalSubjectNames,
} from './cover-plan';
import {
  coverReferenceTreatment,
  EMPTY_COVER_REFERENCE_SELECTION,
  referenceSubjectsForSelection,
  selectCoverReferencesForPlan,
  type CoverReferencePlanSelection,
} from './cover-reference-policy';
import {
  buildPlanWithRelaxedRetry,
  claimAndSubmitCover,
  fallbackForLedger,
  PENDING_STATES,
  persistedCapabilities,
  processedCoverProvenance,
  recoverStoredCoverBytes,
  refusedCoverState,
  reservedRequestProvenance,
  SessionCoverRetryableError,
  settleProcessedCoverReady,
  terminalReasonFor,
  type SessionCoverClock,
  type SessionCoverFallbackReason,
  type SessionCoverLogger,
} from './session-cover-attempt';

export interface PlaylistCoverGeneratorDeps {
  db: Database;
  ownerUserId: string;
  /** Prompt-driven image provider only — a Playlist has no music task to derive from. */
  imageProvider: GeneratedImageProvider | null;
  storage: StorageProvider;
  evaluateCover?: EvaluateCoverImage;
  normalizeCover?: NormalizeCoverImage;
  measureCover?: MeasureImage;
  logger: SessionCoverLogger;
  clock: SessionCoverClock;
}

export type PlaylistCoverResult =
  | { status: 'ready'; coverImageId: string; generatedNow: boolean }
  | { status: 'pending' }
  | { status: 'failed'; reason: SessionCoverFallbackReason }
  | { status: 'missing' };

interface Runtime {
  deps: PlaylistCoverGeneratorDeps;
  evaluate: EvaluateCoverImage;
  finalizer: CoverArtworkFinalizer;
}

const PLAYLIST_COVER_SAFE_RETRY_POLICY_VERSION = 'playlist-cover-safe-retry-v1';
const PLAYLIST_COVER_MAX_SAFE_RETRIES = 1;

function resultFromSettled(ledger: SessionCoverGenerationRow): PlaylistCoverResult {
  if (ledger.state === 'ready') {
    return { status: 'ready', coverImageId: ledger.coverImageId, generatedNow: false };
  }
  return { status: 'failed', reason: fallbackForLedger(ledger) };
}

async function settleReserved(
  runtime: Runtime,
  ledger: SessionCoverGenerationRow,
  now: Date,
  failureCategory: string,
  reason: SessionCoverFallbackReason,
): Promise<PlaylistCoverResult> {
  // A retried job re-enters `planned` (after a safe-to-retry submit failure):
  // these exits must settle it too, or the Playlist keeps a live attempt that
  // blocks its next regeneration. A planned row keeps whatever spend it holds.
  await updateSessionCoverGeneration(runtime.deps.db, {
    ownerUserId: runtime.deps.ownerUserId,
    id: ledger.id,
    state: 'not_admitted',
    possiblyPaid: ledger.possiblyPaid,
    failureCategory,
    settledAt: now,
    updatedAt: now,
    expectedStates: ['reserved', 'planned'],
  });
  return { status: 'failed', reason };
}

function frozenStyle(plan: SessionCoverPlanRecord): CoverStyle {
  return (COVER_STYLES as readonly string[]).includes(plan.selectedStyle)
    ? (plan.selectedStyle as CoverStyle)
    : 'auto';
}

/**
 * The People selection frozen onto one attempt — empty unless the owner asked
 * this attempt for reference photos. Names match against the Playlist's name
 * plus the owner's RAW art direction: a Playlist has no music prompt, so the
 * art-direction box is its only free text, and matching the raw text means LLM
 * enhancement can neither add nor lose a Person. The photo choice is keyed by
 * the ATTEMPT, not the Playlist, so successive regenerations vary which photo of
 * a Person is used while retries of one attempt stay frozen.
 */
async function selectPlaylistCoverReferences(
  tx: DbOrTx,
  args: {
    ownerUserId: string;
    subject: PlaylistCoverSubject;
    attempt: SessionCoverGenerationRow;
    capabilities: GeneratedImageCapabilities;
  },
): Promise<CoverReferencePlanSelection> {
  const { plan } = args.attempt;
  if (!plan.usePeopleReferences) return EMPTY_COVER_REFERENCE_SELECTION;
  return selectCoverReferencesForPlan(tx, {
    ownerUserId: args.ownerUserId,
    contextId: args.attempt.id,
    promptText: [args.subject.name, plan.userGuidance].filter(Boolean).join('\n'),
    capabilities: args.capabilities,
    explicitOptIn: true,
  });
}

/**
 * Freeze the reserved attempt's real plan under the shared per-owner admission
 * lock: the playlist's name and dominant member genres feed the same style
 * grammar as a Session Cover, an explicitly requested People selection is frozen
 * with it, the attempt is counted against the shared cover budget (excluding its
 * own reservation), and every refusal settles terminally.
 */
async function planReserved(
  runtime: Runtime,
  subject: PlaylistCoverSubject,
  ledger: SessionCoverGenerationRow,
  capabilities: GeneratedImageCapabilities,
  now: Date,
): Promise<
  | { kind: 'raced'; row: SessionCoverGenerationRow | null }
  | { kind: 'applied'; row: SessionCoverGenerationRow; terminal: boolean }
> {
  const limits = await getUsageLimits(runtime.deps.db);
  return withOwnerCoverAdmissionLock(runtime.deps.db, runtime.deps.ownerUserId, async (tx) => {
    const current = await getSessionCoverGenerationById(tx, {
      ownerUserId: runtime.deps.ownerUserId,
      id: ledger.id,
    });
    if (!current || current.state !== 'reserved') return { kind: 'raced', row: current };
    const admission = await coverAdmissionDecision(tx, {
      ownerUserId: runtime.deps.ownerUserId,
      instanceLimits: limits,
      now,
      excludeGenerationId: ledger.id,
    });
    const guidance = current.plan.effectiveGuidance ?? current.plan.userGuidance;
    const coverStyle = frozenStyle(current.plan);
    const recentPlans = await listRecentSessionCoverGenerations(tx, {
      ownerUserId: runtime.deps.ownerUserId,
      limit: 24,
    });
    const references = await selectPlaylistCoverReferences(tx, {
      ownerUserId: runtime.deps.ownerUserId,
      subject,
      attempt: current,
      capabilities,
    });
    const planInput = {
      sessionId: subject.id,
      sessionName: subject.name,
      coverConcept: null,
      coverStyle,
      customDefinition: current.plan.customDefinition,
      snapshot: { genreTags: subject.genreTags },
      sessionIntent: null,
      // The art direction is a Playlist's only free text, so it is where a
      // multi-subject scene's real names would otherwise reach the provider —
      // the association a Session applies to its music prompt applies here.
      userGuidance:
        withOrdinalSubjectNames(guidance, referenceSubjectsForSelection(references)) ?? null,
      capabilities,
      referenceTreatment: coverReferenceTreatment(references.selectedReferences),
      referenceSubjectCount: new Set(
        references.selectedReferences.map((reference) => reference.personId),
      ).size,
      selectedPersonIds: references.selectedPersonIds,
      recentFingerprints: recentPlans.map((row) => row.fingerprint),
    };
    const { planned, planningFailure } = buildPlanWithRelaxedRetry(planInput);
    const name = subject.name.normalize('NFC').trim();
    const basePlan: SessionCoverPlanRecord = planned.ok
      ? planned.plan
      : emptySessionCoverPlan({
          sessionName: name,
          selectedStyle: coverStyle,
          resolvedStyle: coverStyle,
          conceptMode: 'title symbol',
          selectedPersonIds: references.selectedPersonIds,
          altText: name || 'Playlist cover',
          diversityRelaxedAxes: [],
        });
    const plan: SessionCoverPlanRecord = {
      ...basePlan,
      ...reservedRequestProvenance(current.plan),
    };
    const terminalReason = terminalReasonFor({
      // Playlist covers have no music task to derive from, so every attempt is
      // prompt-driven and the switch binds unconditionally.
      tailoredCoverArtDenied: !limits.tailoredCoverArtEnabled,
      referenceTerminalReason: references.terminalReason,
      planningFailure,
      withinLimits: admission.admitted,
      planOk: planned.ok,
    });
    const applied = await planReservedSessionCoverGeneration(tx, {
      ownerUserId: runtime.deps.ownerUserId,
      id: ledger.id,
      state: terminalReason ? refusedCoverState(terminalReason) : 'planned',
      plan,
      planVersion: SESSION_COVER_PLAN_VERSION,
      promptVersion: SESSION_COVER_PROMPT_VERSION,
      planHash: hashSessionCoverValue(plan),
      promptHash: hashSessionCoverValue(plan.prompt),
      fingerprint: planned.ok ? planned.fingerprint : {},
      providerKey: capabilities.provider.providerKey,
      model: capabilities.provider.model,
      capabilitySnapshot: capabilities as unknown as Record<string, unknown>,
      capabilityDowngrades: references.capabilityDowngrades,
      retryPolicy: {
        version: PLAYLIST_COVER_SAFE_RETRY_POLICY_VERSION,
        maxSafeRetries: PLAYLIST_COVER_MAX_SAFE_RETRIES,
        requireSameIdempotencyKey: true,
        recentHistoryObserved: recentPlans.length,
      },
      selectedReferences: references.selectedReferences,
      ...(planned.ok && capabilities.nativeSeed ? { seed: String(planned.seed) } : {}),
      maxSafeRetries: PLAYLIST_COVER_MAX_SAFE_RETRIES,
      ...(terminalReason ? { failureCategory: terminalReason, settledAt: now } : {}),
      updatedAt: now,
    });
    if (!applied) return { kind: 'raced', row: current };
    const row = await getSessionCoverGenerationById(tx, {
      ownerUserId: runtime.deps.ownerUserId,
      id: ledger.id,
    });
    if (!row) return { kind: 'raced', row: null };
    return { kind: 'applied', row, terminal: Boolean(terminalReason) };
  });
}

async function settleAt(
  runtime: Runtime,
  ledger: SessionCoverGenerationRow,
  now: Date,
  args: {
    state: SessionCoverGenerationRow['state'];
    failureCategory: string;
    possiblyPaid: boolean;
    expectedStates: SessionCoverGenerationRow['state'][];
  },
): Promise<PlaylistCoverResult> {
  await updateSessionCoverGeneration(runtime.deps.db, {
    ownerUserId: runtime.deps.ownerUserId,
    id: ledger.id,
    state: args.state,
    possiblyPaid: args.possiblyPaid,
    failureCategory: args.failureCategory,
    settledAt: now,
    updatedAt: now,
    expectedStates: args.expectedStates,
  });
  return {
    status: 'failed',
    reason: fallbackForLedger({
      ...ledger,
      state: args.state,
      failureCategory: args.failureCategory,
    }),
  };
}

/** Persist the stored artwork as the attempt's `cover_images` row and settle `ready`. */
async function persistProcessedCover(
  runtime: Runtime,
  subject: PlaylistCoverSubject,
  ledger: SessionCoverGenerationRow,
  args: {
    now: Date;
    capabilityDowngrades: string[];
    costUsd: number | null;
    generatedNow: boolean;
    byteSize: number;
  },
): Promise<PlaylistCoverResult> {
  await settleProcessedCoverReady(runtime.deps.db, {
    ownerUserId: runtime.deps.ownerUserId,
    ledger,
    now: args.now,
    insertCoverImage: () =>
      insertGeneratedPlaylistCoverImage(runtime.deps.db, {
        id: ledger.coverImageId,
        ownerUserId: runtime.deps.ownerUserId,
        playlistId: subject.id,
        storageProvider: runtime.deps.storage.providerKey,
        storageKey: ledger.storageKey,
        byteSize: args.byteSize,
        label: ledger.plan.altText,
        model: ledger.model,
        visualTheme: ledger.plan.resolvedStyle,
        provenance: {
          ...processedCoverProvenance(ledger, args),
          // Which photos produced this artwork — ids and roles only, the same
          // public provenance a Session Cover carries.
          referenceIds: ledger.selectedReferences.map((reference) => reference.id),
        },
      }),
  });
  // A regenerated cover never lands by itself: it joins the playlist's history
  // and waits for the user to confirm the swap (the select route re-points).
  return { status: 'ready', coverImageId: ledger.coverImageId, generatedNow: args.generatedNow };
}

/** Re-drive a `storing` attempt from its stored bytes (a crash-recovery reentry). */
async function recoverStored(
  runtime: Runtime,
  subject: PlaylistCoverSubject,
  ledger: SessionCoverGenerationRow,
  now: Date,
): Promise<PlaylistCoverResult> {
  return recoverStoredCoverBytes({
    storage: runtime.deps.storage,
    evaluate: runtime.evaluate,
    ledger,
    settle: (state, failureCategory) =>
      settleAt(runtime, ledger, now, {
        state,
        failureCategory,
        possiblyPaid: true,
        expectedStates: ['storing'],
      }),
    persist: (byteSize) =>
      persistProcessedCover(runtime, subject, ledger, {
        now,
        capabilityDowngrades: ledger.capabilityDowngrades,
        costUsd: ledger.costUsd,
        generatedNow: false,
        byteSize,
      }),
  });
}

async function execute(
  runtime: Runtime,
  subject: PlaylistCoverSubject,
  ledger: SessionCoverGenerationRow,
  capabilities: GeneratedImageCapabilities,
  now: Date,
): Promise<PlaylistCoverResult> {
  const submitted = await claimAndSubmitCover(runtime.deps.db, {
    provider: runtime.deps.imageProvider!,
    ownerUserId: runtime.deps.ownerUserId,
    ledger,
    capabilities,
    storage: runtime.deps.storage,
    now,
  });
  if (submitted.kind === 'pending') return { status: 'pending' };
  // Already settled inside the lock window: the reference request could not be honored.
  if (submitted.kind === 'refused') return { status: 'failed', reason: submitted.reason };
  if (submitted.kind === 'retry') throw new SessionCoverRetryableError();
  if (submitted.kind !== 'generated') {
    return { status: 'failed', reason: fallbackForLedger({ ...ledger, state: submitted.kind }) };
  }
  const { generated } = submitted;

  const processed = await runtime.finalizer.finish({ bytes: generated.bytes });
  if (!processed.ok) {
    return settleAt(runtime, ledger, now, {
      state: 'quality_rejected',
      failureCategory: processed.reason,
      possiblyPaid: true,
      expectedStates: ['storing'],
    });
  }
  try {
    await runtime.deps.storage.write({
      key: ledger.storageKey,
      body: processed.bytes,
      mimeType: 'image/webp',
    });
  } catch {
    return settleAt(runtime, ledger, now, {
      state: 'storage_rejected',
      failureCategory: 'storage_rejected',
      possiblyPaid: true,
      expectedStates: ['storing'],
    });
  }
  const ready = await persistProcessedCover(runtime, subject, ledger, {
    now,
    capabilityDowngrades: submitted.requestDowngrades,
    costUsd: generated.reportedCostUsd ?? null,
    generatedNow: true,
    byteSize: processed.bytes.byteLength,
  });
  if (ready.status === 'ready') {
    runtime.deps.logger.info('generated playlist cover', {
      playlistId: subject.id,
      coverImageId: ledger.coverImageId,
    });
  }
  return ready;
}

async function drive(
  runtime: Runtime,
  subject: PlaylistCoverSubject,
  ledger: SessionCoverGenerationRow,
): Promise<PlaylistCoverResult> {
  if (!PENDING_STATES.has(ledger.state)) return resultFromSettled(ledger);
  const now = runtime.deps.clock.now();
  if (ledger.state === 'storing') return recoverStored(runtime, subject, ledger, now);
  if (ledger.state === 'submitting') {
    // A previous run crashed between claim and outcome — the spend is unknown
    // and the conservative settlement counts it (mirrors the session posture
    // for a provider without recoverable idempotency).
    return settleAt(runtime, ledger, now, {
      state: 'submission_unknown',
      failureCategory: 'submission_unknown',
      possiblyPaid: true,
      expectedStates: ['submitting'],
    });
  }

  const provider = runtime.deps.imageProvider;
  if (!provider) {
    return settleReserved(runtime, ledger, now, 'provider_unconfigured', 'provider_unconfigured');
  }
  let capabilities: GeneratedImageCapabilities;
  try {
    capabilities = await provider.getCapabilities();
  } catch (error) {
    const reason =
      error instanceof GeneratedImageProviderError && error.kind === 'configuration'
        ? ('provider_rejected' as const)
        : ('provider_unavailable' as const);
    return settleReserved(runtime, ledger, now, reason, reason);
  }
  // A Playlist has no music task to derive a cover from; a music-task-driven
  // provider (the Suno fallback) can never serve this attempt.
  if (capabilities.musicTaskSource) {
    return settleReserved(runtime, ledger, now, 'provider_unconfigured', 'provider_unconfigured');
  }

  if (ledger.state === 'reserved') {
    const outcome = await planReserved(runtime, subject, ledger, capabilities, now);
    if (outcome.kind === 'raced') {
      return outcome.row ? drive(runtime, subject, outcome.row) : { status: 'missing' };
    }
    if (outcome.terminal) return { status: 'failed', reason: fallbackForLedger(outcome.row) };
    return execute(runtime, subject, outcome.row, capabilities, now);
  }

  // `planned` reentry (a retried job): re-submit only when the frozen provider
  // is still the configured one — a swapped provider invalidates the plan.
  const frozen = persistedCapabilities(ledger);
  const providerMatches =
    frozen && provider.providerKey === ledger.providerKey && provider.model === ledger.model;
  if (!providerMatches) {
    return settleAt(runtime, ledger, now, {
      state: 'provider_unavailable',
      failureCategory: 'provider_unavailable',
      possiblyPaid: ledger.possiblyPaid,
      expectedStates: ['planned'],
    });
  }
  return execute(runtime, subject, ledger, frozen, now);
}

export interface PlaylistCoverGenerator {
  /** Drive one reserved playlist-cover regeneration attempt to a terminal state. */
  processRegeneration(playlistId: string, coverGenerationId: string): Promise<PlaylistCoverResult>;
}

export function createPlaylistCoverGenerator(
  deps: PlaylistCoverGeneratorDeps,
): PlaylistCoverGenerator {
  const runtime: Runtime = {
    deps,
    evaluate: deps.evaluateCover ?? evaluateCoverImage,
    finalizer: createCoverArtworkFinalizer({
      evaluate: deps.evaluateCover,
      normalize: deps.normalizeCover,
      measure: deps.measureCover,
    }),
  };
  return {
    async processRegeneration(playlistId, coverGenerationId) {
      try {
        const subject = await getPlaylistCoverSubject(deps.db, {
          ownerUserId: deps.ownerUserId,
          playlistId,
        });
        if (!subject) return { status: 'missing' };
        const ledger = await getSessionCoverGenerationById(deps.db, {
          ownerUserId: deps.ownerUserId,
          id: coverGenerationId,
        });
        if (!ledger || ledger.playlistId !== playlistId) return { status: 'missing' };
        return await drive(runtime, subject, ledger);
      } catch (error) {
        throw error instanceof SessionCoverRetryableError
          ? error
          : new SessionCoverRetryableError();
      }
    },
  };
}
