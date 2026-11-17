// The one production entry point for generated Session Covers:
// `ensureGenerated` owns the initial attempt (admission, planning, submission,
// failure settlement) and resumption of aged work; `processRegeneration` drives
// one specific user-regeneration attempt. Attempt machinery is shared with the
// regeneration planner via `session-cover-attempt.ts`.

import { randomUUID } from 'node:crypto';
import type { UsageLimits } from '@liedmotif/db';
import {
  coverAdmissionDecision,
  getSessionById,
  getInitialSessionCoverGeneration,
  getSessionCoverGeneration,
  getSessionCoverGenerationById,
  getUsageLimits,
  lockSessionForCoverPlanning,
  PLACEHOLDER_COVER_ID,
  planSessionCoverGeneration,
  updateSessionCoverGeneration,
  withOwnerCoverAdmissionLock,
  type SessionCoverGenerationRow,
  type SessionRecord,
} from '@liedmotif/db';
import { GeneratedImageProviderError, type GeneratedImageCapabilities } from '@liedmotif/providers';
import { storageKeys } from '@liedmotif/storage';
import { evaluateCoverImage } from '@liedmotif/media';
import { createCoverArtworkFinalizer } from './cover-artwork-finalizer';
import { SESSION_COVER_PLAN_VERSION } from './cover-plan';
import {
  executePlannedCover,
  freezePlanInputs,
  frozenAttemptFields,
  isAged,
  PENDING_STATES,
  persistedCapabilities,
  readySourceMusicTaskId,
  recoverStoredCover,
  resultFromExisting,
  currentCoverFallback,
  SessionCoverRetryableError,
  type Runtime,
  type SessionCoverFallbackReason,
  type SessionCoverGeneratorDeps,
  type SessionCoverResult,
} from './session-cover-attempt';
import { planAndExecuteRegeneration } from './session-cover-regeneration';

export {
  SessionCoverRetryableError,
  type SessionCoverClock,
  type SessionCoverFallbackReason,
  type SessionCoverGeneratorDeps,
  type SessionCoverLogger,
  type SessionCoverMetadataQueue,
  type SessionCoverResult,
} from './session-cover-attempt';

export interface SessionCoverGenerator {
  ensureGenerated(activitySessionId: string): Promise<SessionCoverResult>;
  /**
   * Drive one specific user-triggered regeneration attempt (a reserved ledger
   * row created by the regenerate API route). Plans and submits it under the
   * same admission machinery as the initial attempt, but with regeneration
   * settlement: failure keeps the session's current cover.
   */
  processRegeneration(
    activitySessionId: string,
    coverGenerationId: string,
  ): Promise<SessionCoverResult>;
}

interface Admission {
  ledger: SessionCoverGenerationRow;
  created: boolean;
}

async function admit(
  runtime: Runtime,
  sessionId: string,
  capabilities: GeneratedImageCapabilities,
  limits: UsageLimits,
  now: Date,
  forcedTerminalReason?: string,
): Promise<Admission | null> {
  return withOwnerCoverAdmissionLock(runtime.deps.db, runtime.deps.ownerUserId, async (tx) => {
    const existing = await getInitialSessionCoverGeneration(tx, {
      ownerUserId: runtime.deps.ownerUserId,
      activitySessionId: sessionId,
    });
    if (existing) return { ledger: existing, created: false };
    const session = await lockSessionForCoverPlanning(tx, {
      ownerUserId: runtime.deps.ownerUserId,
      sessionId,
    });
    // A Session whose delete is pending buys no cover; with no attempt row the
    // deferred delete is free to finish.
    if (!session || session.deleteRequestedAt) return null;

    // The caller already holds the per-owner cover-admission lock; a Member's
    // check takes the Pool lock inside (fixed order).
    const decision = await coverAdmissionDecision(tx, {
      ownerUserId: runtime.deps.ownerUserId,
      instanceLimits: limits,
      now,
    });
    const frozen = await freezePlanInputs(tx, session, capabilities, {
      limits,
      withinLimits: decision.admitted,
      ...(forcedTerminalReason ? { forcedTerminalReason } : {}),
      textLlmConfigured: runtime.deps.textLlmConfigured === true,
    });

    const fields = frozenAttemptFields(frozen, frozen.plan, capabilities);
    // The source task is pinned at admission: an older task that turns ready
    // later must not change which music task a safe retry asks to cover.
    const sourceMusicTaskId = capabilities.musicTaskSource
      ? await readySourceMusicTaskId(tx, session, capabilities.musicTaskSource)
      : null;
    const coverImageId = randomUUID();
    const inserted = await planSessionCoverGeneration(tx, {
      id: randomUUID(),
      ownerUserId: session.ownerUserId,
      activitySessionId: session.id,
      ...fields,
      ...(sourceMusicTaskId ? { retryPolicy: { ...fields.retryPolicy, sourceMusicTaskId } } : {}),
      idempotencyKey: `session-cover:${session.id}:${SESSION_COVER_PLAN_VERSION}`,
      coverImageId,
      storageKey: storageKeys.generatedCover(session.ownerUserId, session.id, coverImageId, 'webp'),
      ...(frozen.terminalReason
        ? {
            initialState: 'not_admitted' as const,
            failureCategory: frozen.terminalReason,
            settledAt: now,
          }
        : {}),
    });
    if (!inserted) {
      const raced = await getInitialSessionCoverGeneration(tx, {
        ownerUserId: session.ownerUserId,
        activitySessionId: session.id,
      });
      // No initial row means a user regeneration took the Session's single
      // live slot first; the initial attempt retries once it settles.
      if (!raced) throw new SessionCoverRetryableError();
      return { ledger: raced, created: false };
    }
    return { ledger: inserted, created: true };
  });
}

/**
 * How long after session creation a music-task-driven cover keeps waiting for
 * the session's first ready music task before settling terminally (the session
 * keeps its placeholder cover). A session without ready music by then is
 * effectively dead — retrying its cover forever would never converge on
 * a terminal state.
 */
const MUSIC_TASK_WAIT_MS = 30 * 60 * 1_000;

const UNCONFIGURED_CAPABILITIES: GeneratedImageCapabilities = {
  provider: { providerType: 'image', providerKey: 'unconfigured', model: 'unconfigured' },
  exclusions: 'inline',
  nativeSeed: false,
  idempotency: 'absent',
  references: null,
  squareOutput: 'local_crop',
  maxCandidates: 1,
  costReporting: false,
};

/** Admit with a forced terminal reason and settle the session accordingly. */
async function admitTerminal(
  runtime: Runtime,
  session: SessionRecord,
  capabilities: GeneratedImageCapabilities,
  limits: UsageLimits,
  now: Date,
  reason: SessionCoverFallbackReason,
): Promise<SessionCoverResult> {
  const admission = await admit(runtime, session.id, capabilities, limits, now, reason);
  return admission
    ? resultFromExisting(runtime, session, admission.ledger)
    : currentCoverFallback(runtime, session, reason);
}

async function generate(runtime: Runtime, session: SessionRecord): Promise<SessionCoverResult> {
  let now: Date;
  try {
    now = runtime.deps.clock.now();
  } catch {
    return currentCoverFallback(runtime, session, 'provider_unavailable');
  }
  const limits = await getUsageLimits(runtime.deps.db);
  if (!runtime.deps.imageProvider) {
    return admitTerminal(
      runtime,
      session,
      UNCONFIGURED_CAPABILITIES,
      limits,
      now,
      'provider_unconfigured',
    );
  }
  let capabilities: GeneratedImageCapabilities;
  try {
    capabilities = await runtime.deps.imageProvider.getCapabilities();
  } catch (error) {
    const reason =
      error instanceof GeneratedImageProviderError && error.kind === 'configuration'
        ? 'provider_rejected'
        : 'provider_unavailable';
    const conservative: GeneratedImageCapabilities = {
      ...UNCONFIGURED_CAPABILITIES,
      provider: {
        providerType: 'image',
        providerKey: runtime.deps.imageProvider.providerKey,
        model: runtime.deps.imageProvider.model,
      },
    };
    return admitTerminal(runtime, session, conservative, limits, now, reason);
  }
  if (
    capabilities.musicTaskSource &&
    !(await readySourceMusicTaskId(runtime.deps.db, session, capabilities.musicTaskSource))
  ) {
    // Admission waits for the session's first ready music task (the cover job
    // retries with backoff); past the window it settles terminally.
    if (now.getTime() - session.createdAt.getTime() < MUSIC_TASK_WAIT_MS) {
      throw new SessionCoverRetryableError();
    }
    return admitTerminal(runtime, session, capabilities, limits, now, 'provider_unavailable');
  }
  const admission = await admit(runtime, session.id, capabilities, limits, now);
  if (!admission) {
    return currentCoverFallback(
      runtime,
      session,
      session.title?.trim() ? 'unsupported_capability' : 'invalid_session_name',
    );
  }
  if (!admission.created || admission.ledger.state !== 'planned') {
    return resultFromExisting(runtime, session, admission.ledger);
  }
  return executePlannedCover(runtime, session, admission.ledger, capabilities, now);
}

async function resumeExisting(
  runtime: Runtime,
  session: SessionRecord,
  ledger: SessionCoverGenerationRow,
): Promise<SessionCoverResult> {
  if (!PENDING_STATES.has(ledger.state)) return resultFromExisting(runtime, session, ledger);
  if (ledger.state === 'reserved' && ledger.trigger === 'user_regenerate') {
    // A reserved regeneration attempt carries only the frozen user guidance —
    // its real plan is built by the regeneration planner, never blindly resumed.
    return planAndExecuteRegeneration(runtime, session, ledger);
  }
  const now = runtime.deps.clock.now();
  const aged = isAged(ledger, now);
  if (aged && ledger.state !== 'storing') {
    const stored = await runtime.deps.storage.stat(ledger.storageKey);
    if (stored) {
      const claimedStored = await updateSessionCoverGeneration(runtime.deps.db, {
        ownerUserId: session.ownerUserId,
        id: ledger.id,
        state: 'storing',
        possiblyPaid: ledger.possiblyPaid || ledger.state === 'submitting',
        updatedAt: now,
        expectedStates: [ledger.state],
      });
      if (!claimedStored) return { status: 'pending' };
      return recoverStoredCover(runtime, session, { ...ledger, state: 'storing' }, now);
    }
  }
  if (ledger.state === 'storing') {
    return aged ? recoverStoredCover(runtime, session, ledger, now) : { status: 'pending' };
  }

  const capabilities = persistedCapabilities(ledger);
  const provider = runtime.deps.imageProvider;
  const providerMatches =
    provider && provider.providerKey === ledger.providerKey && provider.model === ledger.model;

  if (ledger.state === 'submitting') {
    if (!aged) return { status: 'pending' };
    if (!capabilities || capabilities.idempotency === 'absent') {
      await updateSessionCoverGeneration(runtime.deps.db, {
        ownerUserId: session.ownerUserId,
        id: ledger.id,
        state: 'submission_unknown',
        possiblyPaid: true,
        submissionDisposition: 'outcome_unknown',
        failureCategory: 'submission_unknown',
        settledAt: now,
        updatedAt: now,
        expectedStates: ['submitting'],
      });
      return currentCoverFallback(runtime, session, 'submission_unknown');
    }
    const nextRetryCount = ledger.safeRetryCount + 1;
    if (nextRetryCount > ledger.maxSafeRetries || !providerMatches) {
      await updateSessionCoverGeneration(runtime.deps.db, {
        ownerUserId: session.ownerUserId,
        id: ledger.id,
        state: 'provider_unavailable',
        possiblyPaid: true,
        submissionDisposition: 'outcome_unknown',
        safeRetryCount: nextRetryCount,
        failureCategory: 'safe_retry_exhausted',
        settledAt: now,
        updatedAt: now,
        expectedStates: ['submitting'],
      });
      return currentCoverFallback(runtime, session, 'provider_unavailable');
    }
    const reopened = await updateSessionCoverGeneration(runtime.deps.db, {
      ownerUserId: session.ownerUserId,
      id: ledger.id,
      state: 'planned',
      possiblyPaid: true,
      submissionDisposition: 'retryable_with_same_key',
      safeRetryCount: nextRetryCount,
      failureCategory: 'safe_retry_pending',
      settledAt: null,
      updatedAt: now,
      expectedStates: ['submitting'],
    });
    if (!reopened) return { status: 'pending' };
    return executePlannedCover(
      runtime,
      session,
      { ...ledger, state: 'planned', safeRetryCount: nextRetryCount },
      capabilities,
      now,
    );
  }

  if (session.deleteRequestedAt) {
    // A Session whose delete is pending buys no cover. Settling the unsubmitted
    // attempt (it keeps whatever spend it holds) lets the deferred delete finish.
    await updateSessionCoverGeneration(runtime.deps.db, {
      ownerUserId: session.ownerUserId,
      id: ledger.id,
      state: 'not_admitted',
      possiblyPaid: ledger.possiblyPaid,
      failureCategory: 'session_delete_pending',
      settledAt: now,
      updatedAt: now,
      expectedStates: ['planned', 'reserved'],
    });
    return currentCoverFallback(runtime, session, 'not_admitted');
  }

  if (ledger.state === 'reserved') {
    if (!aged) return { status: 'pending' };
    const planned = await updateSessionCoverGeneration(runtime.deps.db, {
      ownerUserId: session.ownerUserId,
      id: ledger.id,
      state: 'planned',
      updatedAt: now,
      expectedStates: ['reserved'],
    });
    if (!planned) return { status: 'pending' };
  } else if (!aged && ledger.safeRetryCount === 0) {
    return { status: 'pending' };
  }

  if (!capabilities || !providerMatches) {
    await updateSessionCoverGeneration(runtime.deps.db, {
      ownerUserId: session.ownerUserId,
      id: ledger.id,
      state: 'provider_unavailable',
      possiblyPaid: ledger.possiblyPaid,
      failureCategory: 'provider_unavailable',
      settledAt: now,
      updatedAt: now,
      expectedStates: ['planned', 'reserved'],
    });
    return currentCoverFallback(runtime, session, 'provider_unavailable');
  }
  return executePlannedCover(runtime, session, { ...ledger, state: 'planned' }, capabilities, now);
}

export function createSessionCoverGenerator(
  deps: SessionCoverGeneratorDeps,
): SessionCoverGenerator {
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
    async ensureGenerated(activitySessionId) {
      try {
        const session = await getSessionById(deps.db, {
          ownerUserId: deps.ownerUserId,
          sessionId: activitySessionId,
        });
        if (!session) return { status: 'missing' };
        const existing = await getSessionCoverGeneration(deps.db, {
          ownerUserId: deps.ownerUserId,
          activitySessionId,
        });
        if (
          session.useStandardCover &&
          existing?.trigger === 'user_regenerate' &&
          !(await getInitialSessionCoverGeneration(deps.db, {
            ownerUserId: deps.ownerUserId,
            activitySessionId,
          }))
        ) {
          // A user regeneration never stands in for a standard Session's free
          // initial cover: it is still owed (it lands only over the placeholder,
          // so a cover the user picked stays). A prompt-driven Session's initial
          // attempt would be a paid image call, so there the regeneration does
          // stand in. A live regeneration holds the Session's single live slot,
          // so the job retries until it settles.
          if (PENDING_STATES.has(existing.state)) throw new SessionCoverRetryableError();
          return await generate(runtime, session);
        }
        if (session.coverImageId && session.coverImageId !== PLACEHOLDER_COVER_ID) {
          if (existing?.state === 'ready' && existing.coverImageId === session.coverImageId) {
            return await resultFromExisting(runtime, session, existing);
          }
          if (!existing || !PENDING_STATES.has(existing.state)) {
            return { status: 'preserved', coverImageId: session.coverImageId };
          }
        }
        // A live user regeneration is driven only through `processRegeneration`,
        // whose caller resolves the prompt-driven provider; this entry
        // point may hold a standard Session's music-task provider.
        if (existing?.trigger === 'user_regenerate' && PENDING_STATES.has(existing.state)) {
          return { status: 'pending' };
        }
        if (existing) return await resumeExisting(runtime, session, existing);
        return await generate(runtime, session);
      } catch (error) {
        throw error instanceof SessionCoverRetryableError
          ? error
          : new SessionCoverRetryableError();
      }
    },
    async processRegeneration(activitySessionId, coverGenerationId) {
      try {
        const session = await getSessionById(deps.db, {
          ownerUserId: deps.ownerUserId,
          sessionId: activitySessionId,
        });
        if (!session) return { status: 'missing' };
        const ledger = await getSessionCoverGenerationById(deps.db, {
          ownerUserId: deps.ownerUserId,
          id: coverGenerationId,
        });
        if (!ledger || ledger.activitySessionId !== activitySessionId) {
          return { status: 'missing' };
        }
        if (PENDING_STATES.has(ledger.state)) return await resumeExisting(runtime, session, ledger);
        return await resultFromExisting(runtime, session, ledger);
      } catch (error) {
        throw error instanceof SessionCoverRetryableError
          ? error
          : new SessionCoverRetryableError();
      }
    },
  };
}
