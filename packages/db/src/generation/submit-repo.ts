// Generation-request / provider-job writes for the buffer controller's generate
// path. Money-idempotency posture: the provider job is
// created in a SUBMIT state BEFORE the paid call — so it counts toward the limit
// window the moment we intend to spend — then promoted to `submitted` with the
// captured `providerTaskId` once the provider confirms. The unique index
// `provider_jobs_generation_request_id_unique` guarantees one paid job per request.

import { and, eq, isNull } from 'drizzle-orm';
import {
  assertNoProviderResubmitAfterTask,
  type BlendIdentity,
  type ProviderDiagnostics,
  type ProviderNormalizedStatus,
} from '@liedmotif/shared';
import type { Database } from '../client';
import type { Transaction } from '../transactions';
import { generationRequests, providerJobs, type StyleSnapshot } from '../schema';

export interface InsertSubmittingGenerationJobInput {
  ownerUserId: string;
  activitySessionId: string;
  providerKey: string;
  /** The SESSION-frozen compiled style (no per-track variation) — the request's
   *  style identity for diagnostics and the policy-block comparison. */
  stylePrompt?: string;
  promptFingerprint?: string;
  requestedTrackCount?: number;
  /** The request's zero-based index within its session, the seed track
   *  materialization uses to give the call's sibling tracks DISTINCT titles. */
  titleSeed?: number;
  /** Generation-time blend identity: the
   *  snapshot revision + frozen BPM/key this request compiles AGAINST (or, on a
   *  Dislike reroll, copied from the original request). Omitted/null fields stay
   *  null — and a null identity always forces a plain edge in the player. */
  identity?: BlendIdentity;
  /** The validated snapshot this request compiled from (the reroll compilation
   *  context) — copied from the original request on a reroll. */
  styleSnapshot?: StyleSnapshot | null;
  /** The compiled input's negative tags, persisted for provenance. */
  negativePrompt?: string | null;
  /** The session's prompt history frozen at submit time — what Track Data shows
   *  for this request's Tracks forever after, whatever the session becomes.
   *  `''` freezes "no prompt"; only an absent stamp (null) is the legacy case
   *  Track Data fills from the live session. */
  userPrompt?: string | null;
}

/**
 * Create the generation-request + its single provider-job in a `submitting`
 * state so the intent-to-spend is recorded before the paid call. Requires the
 * caller's OPEN transaction — in production that is always the per-owner
 * generation lock (`withOwnerGenerationLock`), which is what makes the
 * count-check-insert sequence atomic per owner; requiring a `Transaction`
 * enforces that structurally (no standalone insert can bypass the chokepoint),
 * and the pair commits atomically with the caller.
 */
export async function insertSubmittingGenerationJob(
  tx: Transaction,
  input: InsertSubmittingGenerationJobInput,
): Promise<{ requestId: string; jobId: string }> {
  const [request] = await tx
    .insert(generationRequests)
    .values({
      ownerUserId: input.ownerUserId,
      activitySessionId: input.activitySessionId,
      source: 'controls',
      providerType: 'music',
      providerKey: input.providerKey,
      status: 'awaiting_results',
      ...(input.stylePrompt !== undefined ? { stylePrompt: input.stylePrompt } : {}),
      ...(input.promptFingerprint !== undefined
        ? { promptFingerprint: input.promptFingerprint }
        : {}),
      ...(input.requestedTrackCount !== undefined
        ? { requestedTrackCount: input.requestedTrackCount }
        : {}),
      ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
      ...(input.identity?.styleRevision != null
        ? { styleRevision: input.identity.styleRevision }
        : {}),
      ...(input.identity?.targetBpm != null ? { targetBpm: input.identity.targetBpm } : {}),
      ...(input.identity?.targetKey != null ? { targetKey: input.identity.targetKey } : {}),
      ...(input.styleSnapshot != null ? { styleSnapshot: input.styleSnapshot } : {}),
      ...(input.negativePrompt != null ? { negativePrompt: input.negativePrompt } : {}),
      ...(input.userPrompt != null ? { userPrompt: input.userPrompt } : {}),
    })
    .returning({ id: generationRequests.id });
  const requestId = request!.id;

  const [job] = await tx
    .insert(providerJobs)
    .values({
      generationRequestId: requestId,
      providerType: 'music',
      providerKey: input.providerKey,
      submitState: 'submitting',
      normalizedStatus: 'queued',
    })
    .returning({ id: providerJobs.id });
  return { requestId, jobId: job!.id };
}

/**
 * Replace a request's frozen compilation snapshot in place. Sole caller: the
 * buffer controller's post-lock track-lyric-brief injection, which must land
 * the brief-carrying copy BEFORE the paid provider call — the stored snapshot
 * and the submitted input must never disagree, because a Dislike reroll
 * re-compiles this row and has to reproduce what actually went out.
 */
export async function updateRequestStyleSnapshot(
  db: Database,
  args: { requestId: string; styleSnapshot: StyleSnapshot },
): Promise<void> {
  await db
    .update(generationRequests)
    .set({ styleSnapshot: args.styleSnapshot })
    .where(eq(generationRequests.id, args.requestId));
}

function diagnosticsColumns(diagnostics: ProviderDiagnostics | undefined): Partial<{
  rawRequest: unknown;
  rawResponse: unknown;
}> {
  return {
    ...(diagnostics?.rawRequest !== undefined ? { rawRequest: diagnostics.rawRequest } : {}),
    ...(diagnostics?.rawResponse !== undefined ? { rawResponse: diagnostics.rawResponse } : {}),
  };
}

/**
 * Promote a `submitting` provider job to `submitted` with the captured task id.
 * Guarded by `assertNoProviderResubmitAfterTask` so a job that already holds a
 * task id can never be re-submitted (money safety).
 */
export async function markProviderJobSubmitted(
  db: Database,
  args: {
    jobId: string;
    providerTaskId: string;
    now?: Date;
    diagnostics?: ProviderDiagnostics;
  },
): Promise<void> {
  const now = args.now ?? new Date();
  const [existing] = await db
    .select({ providerTaskId: providerJobs.providerTaskId })
    .from(providerJobs)
    .where(eq(providerJobs.id, args.jobId))
    .limit(1);
  assertNoProviderResubmitAfterTask(existing?.providerTaskId != null, 'submitted');

  await db
    .update(providerJobs)
    .set({
      providerTaskId: args.providerTaskId,
      submitState: 'submitted',
      normalizedStatus: 'submitted',
      lastSubmitAttemptAt: now,
      ...diagnosticsColumns(args.diagnostics),
    })
    .where(eq(providerJobs.id, args.jobId));
}

/**
 * How a submit that returned no task id ended, and with it whether the attempt
 * consumes the spend window:
 *
 * - `submit_unknown` — the outcome is uncertain (the call threw before
 *   returning a task id, or its task id could not be persisted), so it may have
 *   charged and keeps counting as spend;
 * - `submit_rejected` — the provider definitively refused the call, or the
 *   adapter refused the input before dialing, so it provably charged nothing
 *   and does NOT count. Reserved for a `ProviderUnbilledError`; every ambiguous
 *   failure must take `submit_unknown` instead.
 */
export type UnsubmittedJobOutcome = 'submit_unknown' | 'submit_rejected';

/**
 * The status a `submit_rejected` park records instead of `submit_rejected`
 * when the refusal clears without any change to the request (out of credits,
 * provider maintenance, a rate limit): a status the buffer controller blocks on
 * only for its cooldown, after which a NEW job is submitted.
 */
export type RecoverableRefusalStatus = Extract<
  ProviderNormalizedStatus,
  'blocked_by_provider_credits' | 'failed_final' | 'provider_rate_limited'
>;

/**
 * Park a job whose submit ended without a task id. It is NEVER auto-resubmitted,
 * so a Graphile retry can't issue a second paid call for the same intended
 * track: a `submit_unknown` row holds the in-flight buffer slot, a plain
 * `submit_rejected` blocks the session until the provider config changes or the
 * listener resumes, and a recoverable status blocks it until that status's
 * cooldown ends; after either block only a NEW job is submitted. The
 * outcome alone decides the spend classification above. Only ever parks a job
 * that holds NO task id (a job that already captured one is already money-safe).
 */
export async function parkUnsubmittedProviderJob(
  db: Database,
  args: { jobId: string; now?: Date } & (
    | { outcome: 'submit_unknown' }
    | { outcome: 'submit_rejected'; recoverableAs?: RecoverableRefusalStatus }
  ),
): Promise<void> {
  const now = args.now ?? new Date();
  await db
    .update(providerJobs)
    .set({
      submitState: args.outcome,
      normalizedStatus:
        args.outcome === 'submit_rejected' ? (args.recoverableAs ?? args.outcome) : args.outcome,
      lastSubmitAttemptAt: now,
    })
    .where(and(eq(providerJobs.id, args.jobId), isNull(providerJobs.providerTaskId)));
}

/**
 * Failure-safe persist of a returned provider task id when the normal promote failed
 * (e.g. a transient DB error, or a unique-index clash on the task id). Tries once more
 * to record the task id (so the paid call is never orphaned); if even that can't land
 * it, parks the job as `submit_unknown`. It is the money-safety net the caller runs
 * before re-raising the original error, and it must leave the row in a state a retry
 * will not re-submit. It throws only when the park write fails too; the row then
 * stays `submitting`, counted as spend and held like a submit that crashed mid-call.
 */
export async function recordProviderTaskIdFailSafe(
  db: Database,
  args: {
    jobId: string;
    providerTaskId: string;
    now?: Date;
    diagnostics?: ProviderDiagnostics;
  },
): Promise<void> {
  const now = args.now ?? new Date();
  try {
    await db
      .update(providerJobs)
      .set({
        providerTaskId: args.providerTaskId,
        submitState: 'submitted',
        normalizedStatus: 'submitted',
        lastSubmitAttemptAt: now,
        ...diagnosticsColumns(args.diagnostics),
      })
      .where(and(eq(providerJobs.id, args.jobId), isNull(providerJobs.providerTaskId)));
  } catch {
    await parkUnsubmittedProviderJob(db, { jobId: args.jobId, outcome: 'submit_unknown', now });
  }
}
