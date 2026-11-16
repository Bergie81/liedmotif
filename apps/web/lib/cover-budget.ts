// The cover-spend admission gate for the web-boundary routes that run the paid
// cover-text enhancement: the regenerate routes and the Custom style save.
//
// The paid LLM cover-text enhancement runs OUTSIDE the owner admission lock (it
// must — see the paid-cover-calls-outside-the-lock invariant), so a
// budget-exhausted member tapping Regenerate would otherwise burn one unmetered
// LLM call per tap before the in-lock check refuses. This advisory, lock-free
// precheck refuses first, with the exact copy the authoritative in-lock decision
// produces. It never spends and is racy by design: a race only ever costs one
// enhancement, and `coverAdmissionDecision` under the lock stays the authority.

import { NextResponse } from 'next/server';
import { advisoryCoverAdmission, type UsageLimits } from '@liedmotif/db';
import { ACCOUNT_DISABLED_MESSAGE } from '@/lib/constants';
import { apiError } from '@/lib/api-response';
import { getDb } from '@/lib/db';

/** The refusal copy for a cover attempt over its budget window — one source, so
 *  the precheck and the in-lock refusal always read identically. */
export const COVER_LIMIT_REACHED_MESSAGE = 'The cover generation limit is reached for this window.';

/**
 * The response a cover-regenerate route must return instead of running the paid
 * enhancement, or null when the owner is within budget. Advisory: the worker /
 * in-lock admission stays authoritative and re-checks under the lock.
 */
export async function refuseWhenCoverBudgetExhausted(args: {
  ownerUserId: string;
  instanceLimits: UsageLimits;
}): Promise<NextResponse | null> {
  const admission = await advisoryCoverAdmission(getDb(), { ...args, now: new Date() });
  if (admission.admitted) return null;
  return admission.reason === 'account_disabled'
    ? apiError('unauthorized', ACCOUNT_DISABLED_MESSAGE, { status: 403 })
    : apiError('limit_reached', COVER_LIMIT_REACHED_MESSAGE);
}
