// The `usage_events` spend ledger. Append-only
// diagnostics: one row per paid provider call, written by the worker's submit
// path AFTER the call is issued — success and uncertain-outcome
// (`submit_unknown`) alike, since either may have charged. Units follow the
// domain's internal counting (task = one ProviderJob = one provider
// call); the ledger NEVER feeds limit enforcement — `countTasksInWindow` counts
// `provider_jobs` rows so a lost diagnostic row can never under-count spend.
// Credit before/after snapshots and non-music operations land with the credit
// diagnostics.

import type { ProviderType } from '@liedmotif/shared';
import type { Database } from '../client';
import { usageEvents } from '../schema';

export interface RecordUsageEventInput {
  userId: string;
  providerType: ProviderType;
  providerKey: string;
  /** Open vocabulary (e.g. `generate`) — text, not an enum (see schema enums). */
  operation: string;
  /** Internal task units: one per provider call, NOT per track. */
  units: number;
  /** Diagnostic context only — never secrets, prompts, or provider URLs. */
  metadata?: Record<string, unknown>;
}

/**
 * Append one usage-ledger row. Plain insert with no side effects; callers on the
 * money path wrap it best-effort (a failed diagnostic write must never fail or
 * retry a paid submit).
 */
export async function recordUsageEvent(
  db: Database,
  input: RecordUsageEventInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(usageEvents)
    .values({
      userId: input.userId,
      providerType: input.providerType,
      providerKey: input.providerKey,
      operation: input.operation,
      units: input.units,
      metadata: input.metadata ?? null,
    })
    .returning({ id: usageEvents.id });
  return { id: row!.id };
}
