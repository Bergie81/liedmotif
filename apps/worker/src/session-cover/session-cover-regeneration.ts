// The user-regeneration planner: turns a
// reserved attempt — created by the regenerate API route with only the frozen
// user guidance — into a fully planned, submitted attempt, under the same
// admission machinery as the initial flow. Every refusal settles the attempt
// terminally while the session keeps its current cover.

import type { SessionCoverPlanRecord, SessionRecord } from '@liedmotif/db';
import {
  coverAdmissionDecision,
  getSessionCoverGenerationById,
  getUsageLimits,
  lockSessionForCoverPlanning,
  planReservedSessionCoverGeneration,
  updateSessionCoverGeneration,
  withOwnerCoverAdmissionLock,
  type SessionCoverGenerationRow,
} from '@liedmotif/db';
import { GeneratedImageProviderError, type GeneratedImageCapabilities } from '@liedmotif/providers';
import {
  executePlannedCover,
  fallbackForLedger,
  freezePlanInputs,
  frozenAttemptFields,
  refusedCoverState,
  reservedRequestProvenance,
  resultFromExisting,
  currentCoverFallback,
  type Runtime,
  type SessionCoverFallbackReason,
  type SessionCoverResult,
} from './session-cover-attempt';

async function settleReservedRegeneration(
  runtime: Runtime,
  session: SessionRecord,
  ledger: SessionCoverGenerationRow,
  now: Date,
  failureCategory: string,
  reason: SessionCoverFallbackReason,
): Promise<SessionCoverResult> {
  await updateSessionCoverGeneration(runtime.deps.db, {
    ownerUserId: session.ownerUserId,
    id: ledger.id,
    state: 'not_admitted',
    possiblyPaid: false,
    failureCategory,
    settledAt: now,
    updatedAt: now,
    expectedStates: ['reserved'],
  });
  return currentCoverFallback(runtime, session, reason);
}

/**
 * Plan and run a reserved user-regeneration attempt: freeze its real plan
 * (references, style grammar, guidance) under the admission lock, count it
 * against the cover limits (excluding its own reservation), then submit.
 */
export async function planAndExecuteRegeneration(
  runtime: Runtime,
  session: SessionRecord,
  ledger: SessionCoverGenerationRow,
): Promise<SessionCoverResult> {
  let now: Date;
  try {
    now = runtime.deps.clock.now();
  } catch {
    return currentCoverFallback(runtime, session, 'provider_unavailable');
  }
  const limits = await getUsageLimits(runtime.deps.db);
  const provider = runtime.deps.imageProvider;
  if (!provider) {
    return settleReservedRegeneration(
      runtime,
      session,
      ledger,
      now,
      'provider_unconfigured',
      'provider_unconfigured',
    );
  }
  let capabilities: GeneratedImageCapabilities;
  try {
    capabilities = await provider.getCapabilities();
  } catch (error) {
    const reason =
      error instanceof GeneratedImageProviderError && error.kind === 'configuration'
        ? 'provider_rejected'
        : 'provider_unavailable';
    return settleReservedRegeneration(runtime, session, ledger, now, reason, reason);
  }

  type PlanOutcome =
    | { kind: 'missing' }
    | { kind: 'delete_pending' }
    | { kind: 'raced'; row: SessionCoverGenerationRow | null }
    | { kind: 'applied'; row: SessionCoverGenerationRow; terminal: boolean };
  const outcome = await withOwnerCoverAdmissionLock(
    runtime.deps.db,
    runtime.deps.ownerUserId,
    async (tx): Promise<PlanOutcome> => {
      const current = await getSessionCoverGenerationById(tx, {
        ownerUserId: runtime.deps.ownerUserId,
        id: ledger.id,
      });
      if (!current || current.state !== 'reserved') return { kind: 'raced', row: current };
      const locked = await lockSessionForCoverPlanning(tx, {
        ownerUserId: runtime.deps.ownerUserId,
        sessionId: session.id,
      });
      if (!locked) return { kind: 'missing' };
      // Session delete marks a pending delete under this admission lock.
      if (locked.deleteRequestedAt) return { kind: 'delete_pending' };
      // Caller holds the per-owner cover-admission lock; a Member's check takes
      // the Pool lock inside (fixed order).
      const decision = await coverAdmissionDecision(tx, {
        ownerUserId: runtime.deps.ownerUserId,
        instanceLimits: limits,
        now,
        excludeGenerationId: ledger.id,
      });
      const guidance = current.plan.effectiveGuidance ?? current.plan.userGuidance;
      const frozen = await freezePlanInputs(tx, locked, capabilities, {
        limits,
        withinLimits: decision.admitted,
        ...(guidance ? { guidance } : {}),
        enhancementApplied: current.plan.enhancementApplied === true,
      });
      const plan: SessionCoverPlanRecord = {
        ...frozen.plan,
        ...reservedRequestProvenance(current.plan),
      };
      const applied = await planReservedSessionCoverGeneration(tx, {
        ownerUserId: runtime.deps.ownerUserId,
        id: ledger.id,
        state: frozen.terminalReason ? refusedCoverState(frozen.terminalReason) : 'planned',
        ...frozenAttemptFields(frozen, plan, capabilities),
        ...(frozen.terminalReason
          ? { failureCategory: frozen.terminalReason, settledAt: now }
          : {}),
        updatedAt: now,
      });
      if (!applied) return { kind: 'raced', row: current };
      const row = await getSessionCoverGenerationById(tx, {
        ownerUserId: runtime.deps.ownerUserId,
        id: ledger.id,
      });
      if (!row) return { kind: 'raced', row: null };
      return { kind: 'applied', row, terminal: Boolean(frozen.terminalReason) };
    },
  );
  if (outcome.kind === 'missing') return { status: 'missing' };
  if (outcome.kind === 'delete_pending') {
    // No cover for a Session whose delete is pending; settling the reservation
    // lets the deferred delete finish.
    return settleReservedRegeneration(
      runtime,
      session,
      ledger,
      now,
      'session_delete_pending',
      'not_admitted',
    );
  }
  if (outcome.kind === 'raced') {
    return outcome.row ? resultFromExisting(runtime, session, outcome.row) : { status: 'missing' };
  }
  if (outcome.terminal) {
    return currentCoverFallback(runtime, session, fallbackForLedger(outcome.row));
  }
  return executePlannedCover(runtime, session, outcome.row, capabilities, now);
}
